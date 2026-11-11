import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  adjustGroupCredit, claimInvite, closeGroup, createGroup, getGroup, inviteMember,
  listGroups, removeMember, updateGroup,
  type GroupRow,
} from "@/lib/groups";
import {
  canTransitionEvent, createEvent, getEvent, issuePass, listEvents, listPasses,
  redeemPass, transitionEvent, updateEvent, hashPassCode, newPassCode, type EventRow,
} from "@/lib/events-program";

/* ── fake supabase ────────────────────────────────────────────────────── */

type Row = Record<string, any>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Minimal chainable Supabase fake covering groups/events/entitlement tables. */
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    rental_groups: [], rental_group_members: [], entitlement_events: [], entitlement_grants: [],
    event_programs: [], event_passes: [], prepaid_packages: [], audit_logs: [],
    ...seed,
  };
  const rpcCalls: { fn: string; args: Row }[] = [];
  /** Per-test RPC overrides: return a canned {data,error} to force error paths. */
  const rpcOverrides: Record<string, (args: Row) => { data?: unknown; error?: { message: string } | null }> = {};
  let seq = 0;
  const genId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  const db = {
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      const ov = rpcOverrides[fn];
      if (ov) return ov(args);
      if (fn === "redeem_event_pass") {
        // Faithful stand-in for migration 0034's redeem_event_pass().
        const raise = (m: string) => ({ data: null, error: { message: m } });
        const p = (tables.event_passes as Row[]).find((r) => r.code_hash === args.p_code_hash);
        if (!p) return raise("invalid_code");
        const now = Date.now();
        if (!p.paid_at) return raise("unpaid");
        if (p.status === "revoked") return raise("revoked");
        if (p.status === "redeemed") return raise("already_redeemed");
        if (p.status === "expired" || (p.expires_at && Date.parse(p.expires_at) <= now)) {
          if (p.status === "active") p.status = "expired";
          return raise("expired");
        }
        if (p.status !== "active") return raise("unavailable");
        if ((p.units_used ?? 0) >= (p.units_granted ?? 0)) return raise("exhausted");
        const e = (tables.event_programs as Row[]).find((r) => r.id === p.event_id);
        if (!e) return raise("event_missing");
        if (e.status !== "active") return raise("event_inactive");
        if (now < Date.parse(e.starts_at) || now > Date.parse(e.ends_at)) return raise("outside_window");
        p.status = "redeemed";
        p.units_used = p.units_granted;
        p.holder_id = args.p_profile;
        tables.entitlement_grants.push({
          id: genId(), profile_id: args.p_profile, kind: "event", unit: "rental",
          granted: p.units_granted, remaining: p.units_granted, expires_at: e.ends_at,
          source_type: "event_pass", source_id: p.id, status: "active",
        });
        tables.entitlement_events.push({
          id: genId(), grant_id: null, profile_id: args.p_profile, event: "grant",
          delta: p.units_granted, balance_after: p.units_granted,
          ref_type: "event_pass", ref_id: p.id, actor: "customer", note: "Event pass",
        });
        return { data: p.units_granted, error: null };
      }
      if (fn === "adjust_group_credit") {
        // Faithful stand-in for migration 0035's adjust_group_credit().
        const g = (tables.rental_groups as Row[]).find((r) => r.id === args.p_group);
        if (!g) return { data: null, error: { message: "group_not_found" } };
        const d = args.p_delta;
        if (!Number.isInteger(d) || d === 0 || Math.abs(d) > 10_000_000) {
          return { data: null, error: { message: "invalid_delta" } };
        }
        const next = (g.credit_cents ?? 0) + d;
        if (next < 0) return { data: null, error: { message: "negative_balance" } };
        g.credit_cents = next;
        tables.entitlement_events.push({
          id: genId(), profile_id: g.organizer_id, event: "adjust", delta: d,
          balance_after: next, ref_type: "group_credit", ref_id: g.id,
          actor: args.p_actor, note: args.p_note,
        });
        return { data: next, error: null };
      }
      if (fn === "issue_event_pass") {
        // Faithful stand-in for migration 0037's issue_event_pass().
        const raise = (m: string) => ({ data: null, error: { message: m } });
        const e = (tables.event_programs as Row[]).find((r) => r.id === args.p_event);
        if (!e) return raise("event_missing");
        if (e.status === "closed" || e.status === "cancelled") return raise("event_closed");
        if (e.max_redemptions != null) {
          const cnt = (tables.event_passes as Row[]).filter((r) => r.event_id === args.p_event && r.status !== "revoked").length;
          if (cnt >= e.max_redemptions) return raise("cap_reached");
        }
        const id = genId();
        tables.event_passes.push({
          id, event_id: args.p_event, code_hash: args.p_code_hash, units_granted: args.p_units,
          expires_at: args.p_expires_at ?? null, status: "active", units_used: 0,
          holder_id: null, paid_at: null, created_at: "2026-01-01T00:00:00Z",
        });
        return { data: id, error: null };
      }
      if (fn === "grant_entitlement") {
        tables.entitlement_grants.push({
          id: genId(), profile_id: args.p_profile, kind: args.p_kind, unit: args.p_unit,
          granted: args.p_amount, remaining: args.p_amount, expires_at: args.p_expires_at ?? null,
          source_type: args.p_source_type ?? null, source_id: args.p_source_id ?? null, status: "active",
        });
        return { data: genId(), error: null };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      const t = (tables[table] ??= []);
      const filters: ((r: Row) => boolean)[] = [];
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row | Row[] | null = null;
      let wantCount = false;
      const sorts: { col: string; asc: boolean }[] = [];
      let lim = Infinity;
      const matched = () => t.filter((r) => filters.every((f) => f(r)));
      const ordered = () => {
        let l = matched();
        for (const s of [...sorts].reverse()) {
          l = [...l].sort((a, b) => {
            const av = a[s.col], bv = b[s.col];
            const c = av == null ? -1 : bv == null ? 1 : av < bv ? -1 : av > bv ? 1 : 0;
            return s.asc ? c : -c;
          });
        }
        return l.slice(0, lim);
      };
      const run = async () => {
        if (op === "insert" && payload) {
          const items = (Array.isArray(payload) ? payload : [payload]) as Row[];
          const DEFAULTS: Record<string, Row> = {
            rental_groups: { status: "active", credit_cents: 0, max_members: 10, created_at: "2026-01-01T00:00:00Z" },
            rental_group_members: { status: "invited", profile_id: null, invite_email: null, invite_token_hash: null, joined_at: null, created_at: "2026-01-01T00:00:00Z" },
            event_programs: { status: "draft", venue_id: null, package_id: null, max_redemptions: null, price_cents: null, created_at: "2026-01-01T00:00:00Z" },
            event_passes: { holder_id: null, units_used: 0, expires_at: null, status: "active", paid_at: null, stripe_checkout_session_id: null, created_at: "2026-01-01T00:00:00Z" },
          };
          const ins = items.map((p) => ({ ...(DEFAULTS[table] ?? {}), id: p.id ?? genId(), ...p }));
          t.push(...ins);
          return { data: ins, error: null };
        }
        if (op === "update" && payload) {
          const hit = matched();
          hit.forEach((r) => Object.assign(r, payload as Row));
          return { data: hit, error: null };
        }
        if (op === "delete") {
          const hit = matched();
          tables[table] = t.filter((r) => !hit.includes(r));
          return { data: hit, error: null };
        }
        if (wantCount) return { count: matched().length, data: null, error: null };
        return { data: ordered(), error: null };
      };
      const q: Record<string, unknown> = {};
      q.select = (_cols?: unknown, opts?: { count?: string; head?: boolean }) => { if (opts?.count) wantCount = true; return q; };
      q.insert = (p: Row | Row[]) => { op = "insert"; payload = p; return q; };
      q.update = (p: Row) => { op = "update"; payload = p; return q; };
      q.delete = () => { op = "delete"; return q; };
      q.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v || (v === null && (r[col] === null || r[col] === undefined))); return q; };
      q.neq = (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return q; };
      q.in = (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return q; };
      q.is = (col: string, v: unknown) => { filters.push((r) => (v === null ? r[col] === null || r[col] === undefined : r[col] === v)); return q; };
      q.not = (col: string, op2: string, v: unknown) => {
        if (op2 === "is" && v === null) filters.push((r) => r[col] !== null && r[col] !== undefined);
        return q;
      };
      q.order = (col: string, o?: { ascending?: boolean }) => { sorts.push({ col, asc: o?.ascending !== false }); return q; };
      q.limit = (n: number) => { lim = n; return q; };
      q.single = async () => {
        const r = await run();
        const d = Array.isArray(r.data) ? r.data[0] ?? null : (r.data as Row | null);
        return { data: d, error: d ? null : { message: "not found", code: "PGRST116" } };
      };
      q.maybeSingle = async () => {
        const r = await run();
        const d = Array.isArray(r.data) ? r.data[0] ?? null : (r.data as Row | null);
        return { data: d, error: null };
      };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
      return q;
    },
  };
  return { db: db as never, tables, rpcCalls, rpcOverrides };
}

/* ── groups ───────────────────────────────────────────────────────────── */

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG2 = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";

async function makeGroup(db: ReturnType<typeof fakeDb>["db"], organizer = ORG) {
  const g = await createGroup(db, organizer, { name: "Crew", maxMembers: 5 });
  if (!g.ok) throw new Error(g.error);
  return g.data;
}

describe("groups", () => {
  it("stores only the sha256 of invite tokens", async () => {
    const { db, tables } = fakeDb();
    const g = await makeGroup(db);
    const inv = await inviteMember(db, ORG, g.id, "Rider@Example.com");
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    expect(inv.data.token).toBeTruthy();
    expect(inv.data.url).toContain(inv.data.token);
    const stored = tables.rental_group_members[0];
    expect(stored.invite_token_hash).toBe(sha(inv.data.token));
    expect(stored.invite_token_hash).not.toBe(inv.data.token);
    expect(stored.invite_email).toBe("rider@example.com"); // normalized
    expect(JSON.stringify(stored)).not.toContain(inv.data.token);
  });

  it("enforces max_members and duplicate emails", async () => {
    const { db } = fakeDb();
    const g = await makeGroup(db);
    await inviteMember(db, ORG, g.id, "a@x.com");
    const dup = await inviteMember(db, ORG, g.id, "A@x.com");
    expect(dup.ok).toBe(false);
    const tiny = await createGroup(db, ORG, { name: "Tiny", maxMembers: 1 });
    if (!tiny.ok) return;
    await inviteMember(db, ORG, tiny.data.id, "b@x.com");
    const full = await inviteMember(db, ORG, tiny.data.id, "c@x.com");
    expect(full.ok).toBe(false);
  });

  it("claims an invite exactly once", async () => {
    const { db, tables } = fakeDb();
    const g = await makeGroup(db);
    const inv = await inviteMember(db, ORG, g.id, "new@x.com");
    if (!inv.ok) throw new Error("invite failed");

    const first = await claimInvite(db, MEMBER, inv.data.token);
    expect(first.ok).toBe(true);
    const m = tables.rental_group_members[0];
    expect(m.profile_id).toBe(MEMBER);
    expect(m.status).toBe("active");
    expect(m.joined_at).toBeTruthy();

    // Same profile re-claiming is idempotent; a different profile is rejected.
    const again = await claimInvite(db, MEMBER, inv.data.token);
    expect(again.ok).toBe(true);
    const other = await claimInvite(db, ORG2, inv.data.token);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.status).toBe(409);

    // Garbage token → invalid.
    const bad = await claimInvite(db, MEMBER, "not-a-real-token-at-all");
    expect(bad.ok).toBe(false);
  });

  it("isolates groups per organizer", async () => {
    const { db } = fakeDb();
    const g = await makeGroup(db, ORG);
    const inv = await inviteMember(db, ORG, g.id, "x@x.com");
    if (!inv.ok) throw new Error("invite failed");
    expect((await getGroup(db, ORG2, g.id)).ok).toBe(false);
    expect((await inviteMember(db, ORG2, g.id, "y@x.com")).ok).toBe(false);
    expect((await removeMember(db, ORG2, g.id, "00000000-0000-4000-8000-000000000001")).ok).toBe(false);
    expect((await closeGroup(db, ORG2, g.id)).ok).toBe(false);
    expect((await listGroups(db, ORG2))).toHaveLength(0);
    expect((await listGroups(db, ORG))).toHaveLength(1);
  });

  it("removes members and closes groups", async () => {
    const { db, tables } = fakeDb();
    const g = await makeGroup(db);
    const inv = await inviteMember(db, ORG, g.id, "x@x.com");
    if (!inv.ok) throw new Error("invite failed");
    const pending = await inviteMember(db, ORG, g.id, "pending@x.com");
    if (!pending.ok) throw new Error("invite failed");
    const mid = tables.rental_group_members[0].id;
    expect((await removeMember(db, ORG, g.id, mid)).ok).toBe(true);
    expect(tables.rental_group_members[0].status).toBe("removed");
    expect((await closeGroup(db, ORG, g.id)).ok).toBe(true);
    // Outstanding invites can't add members to a closed group.
    const late = await claimInvite(db, ORG2, pending.data.token);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.status).toBe(409);
    expect(tables.rental_group_members.find((m) => m.id === tables.rental_group_members[1].id)!.status).toBe("invited");
    const after = await inviteMember(db, ORG, g.id, "z@x.com");
    expect(after.ok).toBe(false); // closed groups take no invites
    expect((await updateGroup(db, ORG, g.id, { name: "New" })).ok).toBe(false);
    expect((await getGroup(db, ORG, g.id)).ok).toBe(true); // still readable
  });

  it("adjusts credit via the adjust_group_credit RPC", async () => {
    const { db, tables, rpcCalls } = fakeDb();
    const g = await makeGroup(db);
    const out = await adjustGroupCredit(db, g.id, 5000, MEMBER, "top up");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.credit_cents).toBe(5000);

    const call = rpcCalls.find((c) => c.fn === "adjust_group_credit")!;
    expect(call.args.p_group).toBe(g.id);
    expect(call.args.p_delta).toBe(5000);
    expect(call.args.p_actor).toBe(`staff:${MEMBER}`);
    expect(call.args.p_note).toBe("top up");
    // RPC wrote the audit row atomically (no separate lib-side insert).
    const audit = tables.entitlement_events.find((e) => e.ref_id === g.id && e.event === "adjust");
    expect(audit).toBeTruthy();
    expect(audit!.balance_after).toBe(5000);

    // Negative adjustments that would overdraw → 409.
    const neg = await adjustGroupCredit(db, g.id, -999_999, ORG);
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.status).toBe(409);
    // Unknown group → 404.
    const missing = await adjustGroupCredit(db, "99999999-9999-4999-8999-999999999999", 100, ORG);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);
    // Invalid delta rejected before any RPC call.
    const before = rpcCalls.length;
    const bad = await adjustGroupCredit(db, g.id, 0, ORG);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(422);
    expect(rpcCalls.length).toBe(before);
  });
});

/* ── events ───────────────────────────────────────────────────────────── */

const NOW = Date.parse("2026-06-15T12:00:00Z");
const FUTURE = {
  name: "Fest", startsAt: "2026-07-01T18:00:00Z", endsAt: "2026-07-01T23:00:00Z",
  priceCents: 1500, maxRedemptions: 10,
};

async function makeEvent(db: ReturnType<typeof fakeDb>["db"], organizer = ORG, extra = {}) {
  const e = await createEvent(db, organizer, { ...FUTURE, ...extra });
  if (!e.ok) throw new Error(e.error);
  return e.data;
}

describe("event transition rules", () => {
  it("enforces the state machine", () => {
    expect(canTransitionEvent("draft", "active")).toBe(true);
    expect(canTransitionEvent("draft", "paused")).toBe(false);
    expect(canTransitionEvent("active", "closed")).toBe(true);
    expect(canTransitionEvent("closed", "active")).toBe(false);
    expect(canTransitionEvent("cancelled", "draft")).toBe(false);
  });

  it("draft→active requires a sane future window", async () => {
    const { db } = fakeDb();
    const past = await createEvent(db, ORG, { name: "Old", startsAt: "2020-01-01T00:00:00Z", endsAt: "2020-01-02T00:00:00Z" });
    if (!past.ok) throw new Error("create failed");
    const t = await transitionEvent(db, ORG, past.data.id, "active", NOW);
    expect(t.ok).toBe(false); // already ended

    const e = await makeEvent(db);
    expect((await transitionEvent(db, ORG, e.id, "paused", NOW)).ok).toBe(false); // illegal from draft
    const act = await transitionEvent(db, ORG, e.id, "active", NOW);
    expect(act.ok).toBe(true);
    expect(act.ok && act.data.status).toBe("active");
    expect((await transitionEvent(db, ORG, e.id, "closed", NOW)).ok).toBe(true);
    expect((await transitionEvent(db, ORG, e.id, "active", NOW)).ok).toBe(false); // terminal
  });
});

describe("event passes", () => {
  it("issues passes with code shown once, hash-only storage", async () => {
    const { db, tables } = fakeDb();
    const e = await makeEvent(db);
    const out = await issuePass(db, ORG, e.id, { units: 3 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const stored = tables.event_passes[0];
    expect(stored.code_hash).toBe(sha(out.data.code));
    expect(stored.code_hash).not.toBe(out.data.code);
    expect(stored.paid_at).toBeNull();
    // Organizer list never exposes hashes.
    const list = await listPasses(db, ORG, e.id);
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.data[0]).not.toHaveProperty("code_hash");
  });

  it("enforces max_redemptions", async () => {
    const { db } = fakeDb();
    const e = await makeEvent(db, ORG, { maxRedemptions: 1 });
    expect((await issuePass(db, ORG, e.id, { units: 1 })).ok).toBe(true);
    const second = await issuePass(db, ORG, e.id, { units: 1 });
    expect(second.ok).toBe(false);
  });

  it("isolates events per organizer", async () => {
    const { db } = fakeDb();
    const e = await makeEvent(db, ORG);
    expect((await getEvent(db, ORG2, e.id)).ok).toBe(false);
    expect((await updateEvent(db, ORG2, e.id, { name: "Hijack" })).ok).toBe(false);
    expect((await transitionEvent(db, ORG2, e.id, "active", NOW)).ok).toBe(false);
    expect((await issuePass(db, ORG2, e.id, { units: 1 })).ok).toBe(false);
    expect((await listPasses(db, ORG2, e.id)).ok).toBe(false);
    expect(await listEvents(db, ORG2)).toHaveLength(0);
  });
});

describe("pass redemption (redeem_event_pass RPC)", () => {
  // The RPC decides window/expiry against DB time, so tests use a live window.
  const liveWindow = () => ({
    startsAt: new Date(Date.now() - 10 * 60_000).toISOString(), // within draft→active grace
    endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const pay = (tables: Record<string, Row[]>, passId: string) => {
    const row = tables.event_passes.find((r) => r.id === passId)!;
    row.paid_at = new Date().toISOString();
  };

  async function liveEvent(db: ReturnType<typeof fakeDb>["db"], extra: Row = {}) {
    const e = await createEvent(db, ORG, { name: "Live", ...liveWindow(), priceCents: 1500, ...extra });
    if (!e.ok) throw new Error(e.error);
    const t = await transitionEvent(db, ORG, e.data.id, "active", Date.now());
    if (!t.ok) throw new Error(t.error);
    return e.data;
  }

  it("rejects malformed codes without calling the RPC", async () => {
    const { db, rpcCalls } = fakeDb();
    const r = await redeemPass(db, MEMBER, "!!bad!!", Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
    expect(rpcCalls.filter((c) => c.fn === "redeem_event_pass")).toHaveLength(0);
  });

  it("maps every coded RPC failure to its status", async () => {
    const cases: [string, string, number][] = [
      ["invalid_code", "invalid_code", 404],
      ["unpaid", "unpaid", 402],
      ["revoked", "revoked", 410],
      ["already_redeemed", "already_redeemed", 409],
      ["expired", "expired", 410],
      ["exhausted", "exhausted", 409],
      ["event_missing", "event_missing", 404],
      ["event_inactive", "event_inactive", 409],
      ["outside_window", "outside_window", 409],
      ["unavailable", "unavailable", 409],
    ];
    for (const [rpcMsg, error, status] of cases) {
      const { db, rpcOverrides } = fakeDb();
      rpcOverrides.redeem_event_pass = () => ({ data: null, error: { message: rpcMsg } });
      const r = await redeemPass(db, MEMBER, "ABCD-EFGH-JKLM", Date.now());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe(error);
        expect(r.status).toBe(status);
      }
    }
    // Unknown RPC failure → 500 redeem_failed.
    const { db, rpcOverrides } = fakeDb();
    rpcOverrides.redeem_event_pass = () => ({ data: null, error: { message: "connection reset" } });
    const r = await redeemPass(db, MEMBER, "ABCD-EFGH-JKLM", Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("redeem_failed");
      expect(r.status).toBe(500);
    }
  });

  it("rejects unpaid passes via the RPC", async () => {
    const { db, tables } = fakeDb();
    const e = await liveEvent(db);
    const p = await issuePass(db, ORG, e.id, { units: 2 });
    if (!p.ok) throw new Error(p.error);
    const r = await redeemPass(db, MEMBER, p.data.code, Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unpaid");
    expect(tables.event_passes[0].status).toBe("active");
  });

  it("redeems once: claims pass, grants rentals, blocks double-redeem", async () => {
    const { db, tables, rpcCalls } = fakeDb();
    const e = await liveEvent(db);
    const p = await issuePass(db, ORG, e.id, { units: 3 });
    if (!p.ok) throw new Error(p.error);
    pay(tables, p.data.pass.id);

    const r = await redeemPass(db, MEMBER, p.data.code, Date.now());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rentals).toBe(3);

    // RPC was called with the hashed code + profile — never the raw code.
    const call = rpcCalls.find((c) => c.fn === "redeem_event_pass")!;
    expect(call.args.p_code_hash).toBe(hashPassCode(p.data.code));
    expect(call.args.p_profile).toBe(MEMBER);
    expect(JSON.stringify(call.args)).not.toContain(p.data.code);

    const row = tables.event_passes.find((x) => x.id === p.data.pass.id)!;
    expect(row.status).toBe("redeemed");
    expect(row.holder_id).toBe(MEMBER);
    expect(row.units_used).toBe(row.units_granted);
    const grant = tables.entitlement_grants.find((g) => g.source_id === row.id);
    expect(grant).toBeTruthy();
    expect(grant!.profile_id).toBe(MEMBER);
    expect(grant!.unit).toBe("rental");
    expect(grant!.granted).toBe(3);

    // Second redemption → already_redeemed.
    const again = await redeemPass(db, ORG2, p.data.code, Date.now());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("already_redeemed");
  });

  it("surfaces expired / outside_window / event_inactive from the RPC", async () => {
    const { db, tables } = fakeDb();
    const e = await liveEvent(db);

    // Expired pass.
    const p1 = await issuePass(db, ORG, e.id, { units: 1, expiresAt: new Date(Date.now() - 1000).toISOString() });
    if (!p1.ok) throw new Error(p1.error);
    pay(tables, p1.data.pass.id);
    const r1 = await redeemPass(db, MEMBER, p1.data.code, Date.now());
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("expired");
    expect(tables.event_passes.find((r) => r.id === p1.data.pass.id)!.status).toBe("expired");

    // Event paused → event_inactive.
    const p2 = await issuePass(db, ORG, e.id, { units: 1 });
    if (!p2.ok) throw new Error(p2.error);
    pay(tables, p2.data.pass.id);
    await transitionEvent(db, ORG, e.id, "paused", Date.now());
    const paused = await redeemPass(db, MEMBER, p2.data.code, Date.now());
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.error).toBe("event_inactive");

    // Window no longer contains now → outside_window (injected via override).
    const { db: db2, rpcOverrides: ov2 } = fakeDb();
    ov2.redeem_event_pass = () => ({ data: null, error: { message: "outside_window" } });
    const r3 = await redeemPass(db2, MEMBER, p2.data.code, Date.now());
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toBe("outside_window");
  });
});

/* ── misc ─────────────────────────────────────────────────────────────── */

describe("token helpers", () => {
  it("pass codes are unique-ish and hash deterministically", () => {
    const a = newPassCode();
    const b = newPassCode();
    expect(a.code).not.toBe(b.code);
    expect(hashPassCode(a.code.toLowerCase())).toBe(a.hash);
    expect(hashPassCode(` ${a.code} `)).toBe(a.hash); // trim+upper normalize
  });
});
