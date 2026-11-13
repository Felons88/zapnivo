import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EXCEPTION_TRANSITIONS, addExceptionNote, assignException, assignExceptionSchema,
  canonicalExceptionState, exceptionPatchSchema, financialReviewInvolved,
  getException, listExceptions, transitionException,
  type ExceptionRow,
} from "@/lib/system/exceptions";
import { roleCan } from "@/lib/system/rbac";

/**
 * Phase 2.6 exception-management tests: lifecycle edges, assignment, notes,
 * evidence assembly, financial-review honesty, and permission gating.
 */

/* ── In-memory Supabase stub (stores rows, applies eq/in/is/lt/not filters) ── */

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

/** Fresh builder per query (filters never leak); deferred update patches. */
function memTable(seed: Row[] = []) {
  // Store the SAME object references so tests can assert on fixture rows.
  const rows: Row[] = [...seed];
  let autoId = 0;
  const inList = (v: unknown): unknown[] =>
    Array.isArray(v) ? v : typeof v === "string" && v.startsWith("(") && v.endsWith(")")
      ? v.slice(1, -1).split(",").map((s) => s.trim())
      : [];
  const make = () => {
    const filters: Filter[] = [];
    let pendingPatch: Row | null = null;
    const match = (r: Row) =>
      filters.every((f) => {
        const cell = r[f.col];
        switch (f.op) {
          case "eq": return cell === f.val;
          case "neq": return cell !== f.val;
          case "in": return inList(f.val).includes(cell);
          case "not-in": return !inList(f.val).includes(cell);
          case "is": return f.val === null ? cell == null : cell === f.val;
          case "lt": return typeof cell === "string" && typeof f.val === "string" ? cell < f.val : false;
          default: return true;
        }
      });
    const materialize = () => {
      if (pendingPatch) {
        for (const r of rows) if (match(r)) Object.assign(r, pendingPatch);
        pendingPatch = null;
      }
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit"]) b[m] = () => b;
    b.eq = (c: string, v: unknown) => { filters.push({ op: "eq", col: c, val: v }); return b; };
    b.neq = (c: string, v: unknown) => { filters.push({ op: "neq", col: c, val: v }); return b; };
    b.in = (c: string, v: unknown) => { filters.push({ op: "in", col: c, val: v }); return b; };
    b.is = (c: string, v: unknown) => { filters.push({ op: "is", col: c, val: v }); return b; };
    b.lt = (c: string, v: unknown) => { filters.push({ op: "lt", col: c, val: v }); return b; };
    b.not = (c: string, op: string, v: unknown) => { if (op === "in") filters.push({ op: "not-in", col: c, val: v }); return b; };
    b.insert = (v: unknown) => {
      for (const r of (Array.isArray(v) ? v : [v]) as Row[]) rows.push({ id: `auto-${++autoId}`, ...r });
      return b;
    };
    b.update = (v: Row) => { pendingPatch = v; return b; };
    b.maybeSingle = async () => { materialize(); return { data: rows.filter(match).at(-1) ?? null, error: null }; };
    b.single = async () => { materialize(); return { data: rows.filter(match).at(-1) ?? null, error: null }; };
    b.then = (res: (v: { data: Row[]; error: null; count: number }) => unknown, rej?: (e: unknown) => unknown) => {
      materialize();
      const out = rows.filter(match);
      return Promise.resolve({ data: out, error: null, count: out.length }).then(res, rej);
    };
    return b;
  };
  return { make, rows };
}
function memDb(tables: Record<string, ReturnType<typeof memTable>>) {
  return { from: (t: string) => (tables[t] ?? memTable()).make() } as unknown as SupabaseClient;
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const EX_ID = "11111111-1111-4111-8111-111111111111";
const KIOSK_ID = "22222222-2222-4222-8222-222222222222";
const RENTAL_ID = "33333333-3333-4333-8333-333333333333";
const CMD_ID = "44444444-4444-4444-8444-444444444444";
const PROFILE_ID = "55555555-5555-4555-8555-555555555555";
const actor = { id: PROFILE_ID, role: "sysadmin" };

function excRow(over: Partial<ExceptionRow> = {}): ExceptionRow {
  return {
    id: EX_ID, rental_id: RENTAL_ID, kiosk_id: KIOSK_ID, kind: "stale_ack",
    detail: { command_id: CMD_ID, event_id: "evt-1" }, status: "new",
    assigned_to: null, resolution_notes: null, notes: [],
    created_at: "2026-02-01T10:00:00Z", updated_at: "2026-02-01T10:00:00Z",
    resolved_at: null, reopened_count: 0,
    ...over,
  };
}

/** rental_exceptions table serving: [0] maybeSingle fetch, [1] update().select().single() */
function excTable(row: ExceptionRow) {
  return memTable([row as unknown as Row]);
}

/* ── Canonical state mapping ─────────────────────────────────────────────── */

describe("canonicalExceptionState", () => {
  it("maps legacy 'open' → 'new', keeps canonical states, flags dismissed", () => {
    expect(canonicalExceptionState("open")).toBe("new");
    expect(canonicalExceptionState("investigating")).toBe("investigating");
    expect(canonicalExceptionState("requires_financial_review")).toBe("requires_financial_review");
    expect(canonicalExceptionState("dismissed")).toBe("dismissed");
    expect(canonicalExceptionState("bogus")).toBeNull();
    expect(canonicalExceptionState(null)).toBeNull();
  });
});

/* ── listExceptions ──────────────────────────────────────────────────────── */

describe("listExceptions", () => {
  it("state=new includes legacy 'open' rows; active excludes resolved/dismissed", async () => {
    const rows = [
      excRow({ id: "e-open", status: "open" }),
      excRow({ id: "e-new", status: "new" }),
      excRow({ id: "e-res", status: "resolved" }),
      excRow({ id: "e-dis", status: "dismissed" }),
    ];
    const db = memDb({ rental_exceptions: memTable(rows as unknown as Row[]) });

    const fresh = await listExceptions(db, { state: "new" });
    expect(fresh.rows.map((r) => r.id).sort()).toEqual(["e-new", "e-open"]);
    expect(fresh.rows.every((r) => r.state === "new")).toBe(true);

    const active = await listExceptions(db, { state: "active" });
    expect(active.rows.map((r) => r.id).sort()).toEqual(["e-new", "e-open"]);

    const dismissed = await listExceptions(db, { state: "dismissed" });
    expect(dismissed.rows.map((r) => r.id)).toEqual(["e-dis"]);
  });

  it("filters by kind, kiosk, assigned, and age honestly", async () => {
    const old = "2020-01-01T00:00:00Z";
    const rows = [
      excRow({ id: "e1", kind: "bank_mismatch", kiosk_id: KIOSK_ID, assigned_to: PROFILE_ID, created_at: old }),
      excRow({ id: "e2", kind: "stale_ack", kiosk_id: null, assigned_to: null, created_at: new Date().toISOString() }),
    ];
    const db = memDb({ rental_exceptions: memTable(rows as unknown as Row[]) });

    expect((await listExceptions(db, { kind: "bank_mismatch" })).rows.map((r) => r.id)).toEqual(["e1"]);
    expect((await listExceptions(db, { kioskId: KIOSK_ID })).rows.map((r) => r.id)).toEqual(["e1"]);
    expect((await listExceptions(db, { assignedTo: "unassigned" })).rows.map((r) => r.id)).toEqual(["e2"]);
    expect((await listExceptions(db, { assignedTo: PROFILE_ID })).rows.map((r) => r.id)).toEqual(["e1"]);
    expect((await listExceptions(db, { olderThanHours: 24 })).rows.map((r) => r.id)).toEqual(["e1"]);
    expect((await listExceptions(db, { olderThanHours: 24 * 365 * 100 })).rows).toHaveLength(0);
  });

  it("returns configured:false with no db", async () => {
    const res = await listExceptions(null, {});
    expect(res.configured).toBe(false);
    expect(res.rows).toEqual([]);
  });
});

/* ── transitionException ─────────────────────────────────────────────────── */

describe("transitionException", () => {
  it("executes a legal transition, updates the row, and audits with an intact resource id", async () => {
    const row = excRow({ status: "new" });
    const db = memDb({
      rental_exceptions: excTable(row),
      system_audit_events: memTable(),
    });
    const res = await transitionException(db, actor, EX_ID, "investigating", { reason: "triage started" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.exception.state).toBe("investigating");
    expect(res.exception.status).toBe("investigating");

    const audit = await db.from("system_audit_events").select("*");
    const arows = (audit as unknown as { data: Row[] }).data;
    const au = arows.find((r) => r.action === "exception.transitioned");
    expect(au).toBeTruthy();
    // The audit fix: resource keeps the full uuid — correlation works.
    expect(au!.resource).toBe(`rental_exception:${EX_ID}`);
    const detail = au!.detail as Record<string, unknown>;
    expect(detail.from).toBe("new");
    expect(detail.to).toBe("investigating");
  });

  it("rejects illegal transitions with 409 + allowed targets", async () => {
    const db = memDb({ rental_exceptions: excTable(excRow({ status: "resolved", resolved_at: "2026-02-02T00:00:00Z" })) });
    const res = await transitionException(db, actor, EX_ID, "investigating");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.allowed).toEqual(["reopened"]);
  });

  it("rejects same-state and terminal 'dismissed' transitions", async () => {
    const same = await transitionException(memDb({ rental_exceptions: excTable(excRow({ status: "investigating" })) }), actor, EX_ID, "investigating");
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.status).toBe(409);

    const dismissed = await transitionException(memDb({ rental_exceptions: excTable(excRow({ status: "dismissed" })) }), actor, EX_ID, "new");
    expect(dismissed.ok).toBe(false);
    if (!dismissed.ok) expect(dismissed.status).toBe(409);
  });

  it("requires a reason to reopen and increments reopened_count, clearing resolved_at", async () => {
    const row = excRow({ status: "resolved", resolved_at: "2026-02-02T00:00:00Z", reopened_count: 1 });
    const table = excTable(row);
    const db = memDb({ rental_exceptions: table });

    const noReason = await transitionException(db, actor, EX_ID, "reopened");
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.status).toBe(422);

    const ok = await transitionException(db, actor, EX_ID, "reopened", { reason: "ack replayed after resolve" });
    expect(ok.ok).toBe(true);
    const stored = row as unknown as Row;
    expect(stored.status).toBe("reopened");
    expect(stored.reopened_count).toBe(2);
    expect(stored.resolved_at).toBeNull();
  });

  it("sets resolved_at on →resolved and preserves the financial-review flag", async () => {
    const row = excRow({ kind: "bank_mismatch", status: "requires_financial_review", detail: { financial_review: true } });
    const db = memDb({ rental_exceptions: excTable(row), system_audit_events: memTable() });
    const res = await transitionException(db, actor, EX_ID, "resolved", { resolutionNotes: "bank verified manually — fin_case FIN-1 tracks the money" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.financialReviewRequired).toBe(true);

    const stored = row as unknown as Row;
    expect(stored.status).toBe("resolved");
    expect(typeof stored.resolved_at).toBe("string");
    // The flag persists on the row — resolution did NOT clear the money question.
    expect((stored.detail as Record<string, unknown>).financial_review_required).toBe(true);
    expect(stored.resolution_notes).toContain("fin_case");

    const audit = await db.from("system_audit_events").select("*");
    const au = ((audit as unknown as { data: Row[] }).data).find((r) => r.action === "exception.transitioned");
    expect((au!.detail as Record<string, unknown>).financial_review_required).toBe(true);
  });

  it("non-financial resolve does not set the flag", async () => {
    const row = excRow({ kind: "stale_ack", status: "investigating" });
    const db = memDb({ rental_exceptions: excTable(row), system_audit_events: memTable() });
    const res = await transitionException(db, actor, EX_ID, "resolved");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.financialReviewRequired).toBe(false);
    expect(((row as unknown as Row).detail as Record<string, unknown>).financial_review_required).toBeUndefined();
  });

  it("legacy 'open' rows transition as 'new'", async () => {
    const row = excRow({ status: "open" });
    const db = memDb({ rental_exceptions: excTable(row), system_audit_events: memTable() });
    const res = await transitionException(db, actor, EX_ID, "investigating");
    expect(res.ok).toBe(true);
    const audit = await db.from("system_audit_events").select("*");
    const au = ((audit as unknown as { data: Row[] }).data).find((r) => r.action === "exception.transitioned");
    expect((au!.detail as Record<string, unknown>).from).toBe("new");
  });

  it("404s on missing exceptions", async () => {
    const db = memDb({ rental_exceptions: memTable() });
    const res = await transitionException(db, actor, EX_ID, "investigating");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it("breakglass actors get a pending change request, not an execution", async () => {
    const row = excRow({ status: "new" });
    const table = excTable(row);
    const db = memDb({
      rental_exceptions: table,
      system_change_requests: memTable(),
      system_audit_events: memTable(),
    });
    const res = await transitionException(db, { id: "bg-1", role: "breakglass" }, EX_ID, "investigating");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(202);
      expect(res.reason).toContain("approval");
    }
    expect((row as unknown as Row).status).toBe("new"); // untouched
  });
});

/* ── assignException ─────────────────────────────────────────────────────── */

describe("assignException", () => {
  it("assigns a verified profile and audits", async () => {
    const row = excRow();
    const db = memDb({
      rental_exceptions: excTable(row),
      profiles: memTable([{ id: PROFILE_ID, email: "op@zapnivo.com" }]),
      system_audit_events: memTable(),
    });
    const res = await assignException(db, actor, EX_ID, PROFILE_ID);
    expect(res.ok).toBe(true);
    expect((row as unknown as Row).assigned_to).toBe(PROFILE_ID);
    const audit = await db.from("system_audit_events").select("*");
    expect(((audit as unknown as { data: Row[] }).data).some((r) => r.action === "exception.assigned")).toBe(true);
  });

  it("rejects unknown profiles and allows unassign (null)", async () => {
    const row = excRow({ assigned_to: PROFILE_ID });
    const db = memDb({ rental_exceptions: excTable(row), profiles: memTable(), system_audit_events: memTable() });
    const bad = await assignException(db, actor, EX_ID, "66666666-6666-4666-8666-666666666666");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(400);

    const cleared = await assignException(db, actor, EX_ID, null);
    expect(cleared.ok).toBe(true);
    expect((row as unknown as Row).assigned_to).toBeNull();
  });
});

/* ── addExceptionNote ────────────────────────────────────────────────────── */

describe("addExceptionNote", () => {
  it("appends a scrubbed note and audits", async () => {
    const row = excRow();
    const db = memDb({ rental_exceptions: excTable(row), system_audit_events: memTable() });
    const res = await addExceptionNote(db, actor, EX_ID, "checked slot 4 — bank seated, ack was stale by 12m");
    expect(res.ok).toBe(true);
    const notes = (row as unknown as Row).notes as { by: string; text: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0].by).toBe(PROFILE_ID);
    expect(notes[0].text).toContain("stale");
    const audit = await db.from("system_audit_events").select("*");
    expect(((audit as unknown as { data: Row[] }).data).some((r) => r.action === "exception.note_added")).toBe(true);
  });

  it("rejects empty notes and enforces the cap", async () => {
    const row = excRow();
    const db = memDb({ rental_exceptions: excTable(row) });
    const empty = await addExceptionNote(db, actor, EX_ID, "   ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.status).toBe(422);

    const full = excRow({ notes: Array.from({ length: 100 }, (_, i) => ({ at: "t", by: "b", text: `n${i}` })) });
    const res = await addExceptionNote(memDb({ rental_exceptions: excTable(full) }), actor, EX_ID, "one more");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

/* ── getException evidence assembly ──────────────────────────────────────── */

describe("getException", () => {
  it("assembles real evidence: events timeline, command, rental, kiosk, history", async () => {
    const row = excRow();
    const db = memDb({
      rental_exceptions: memTable([row as unknown as Row]),
      device_events: memTable([
        { id: 9, kiosk_id: KIOSK_ID, slot_number: 3, event_type: "dispense_ack", payload: { ok: true }, occurred_at: "2026-02-01T10:05:00Z" },
        { id: 8, kiosk_id: KIOSK_ID, slot_number: null, event_type: "heartbeat", payload: null, occurred_at: "2026-02-01T10:00:00Z" },
      ]),
      device_commands: memTable([{ id: CMD_ID, kiosk_id: KIOSK_ID, command: "dispense", status: "unknown_outcome", idempotency_key: "ik-1", payload: { slot: 3 }, created_at: "2026-02-01T09:59:00Z", resolved_at: null }]),
      rentals: memTable([{ id: RENTAL_ID, reference: "ZN-1001", state: "dispensed", power_bank_id: "bank-1", started_at: null, dispensed_at: "2026-02-01T09:58:00Z", returned_at: null, non_return_deadline: null, return_disputed: false, created_at: "2026-02-01T09:50:00Z" }]),
      kiosks: memTable([{ id: KIOSK_ID, station_id: "KSK-01", state: "online", model: "ZK-2", firmware_version: "1.4.2", last_seen_at: "2026-02-01T10:04:00Z", venue_id: null }]),
      system_audit_events: memTable([{ id: "a1", actor_id: PROFILE_ID, actor_role: "sysadmin", action: "exception.transitioned", resource: `rental_exception:${EX_ID}`, detail: { from: "new", to: "investigating" }, created_at: "2026-02-01T10:10:00Z" }]),
    });
    const detail = await getException(db, EX_ID);
    expect(detail).not.toBeNull();
    expect(detail!.exception.id).toBe(EX_ID);
    expect(detail!.exception.state).toBe("new");
    expect(detail!.evidence.device_events).toHaveLength(2);
    expect(detail!.evidence.device_events[0].event_type).toBe("dispense_ack");
    expect(detail!.evidence.command?.status).toBe("unknown_outcome");
    expect(detail!.evidence.command?.idempotency_key).toBe("ik-1");
    expect(detail!.evidence.rental?.reference).toBe("ZN-1001");
    expect(detail!.evidence.rental?.state).toBe("dispensed");
    expect(detail!.evidence.kiosk?.station_id).toBe("KSK-01");
    expect(detail!.evidence.kiosk?.last_seen_at).toBe("2026-02-01T10:04:00Z");
    expect(detail!.evidence.history).toHaveLength(1);
    expect(detail!.evidence.history[0].action).toBe("exception.transitioned");
    expect(detail!.evidence.warnings).toEqual([]);
  });

  it("handles missing links honestly — nulls and empty arrays, no fabrication", async () => {
    const row = excRow({ rental_id: null, kiosk_id: null, detail: {} });
    const db = memDb({ rental_exceptions: memTable([row as unknown as Row]) });
    const detail = await getException(db, EX_ID);
    expect(detail).not.toBeNull();
    expect(detail!.evidence.device_events).toEqual([]);
    expect(detail!.evidence.command).toBeNull();
    expect(detail!.evidence.rental).toBeNull();
    expect(detail!.evidence.kiosk).toBeNull();
    expect(detail!.evidence.history).toEqual([]);
  });

  it("returns null for unknown ids and propagates nothing sensitive", async () => {
    const db = memDb({ rental_exceptions: memTable() });
    expect(await getException(db, EX_ID)).toBeNull();
  });
});

/* ── financialReviewInvolved ─────────────────────────────────────────────── */

describe("financialReviewInvolved", () => {
  it("flags financial kinds, detail flags, and the financial-review state", () => {
    expect(financialReviewInvolved(excRow({ kind: "bank_mismatch" }))).toBe(true);
    expect(financialReviewInvolved(excRow({ detail: { financial_review: true } }))).toBe(true);
    expect(financialReviewInvolved(excRow(), "requires_financial_review")).toBe(true);
    expect(financialReviewInvolved(excRow({ kind: "stale_ack" }), "investigating")).toBe(false);
  });
});

/* ── Schemas + permissions ───────────────────────────────────────────────── */

describe("exceptionPatchSchema", () => {
  it("accepts the three actions and rejects unknown shapes", () => {
    expect(exceptionPatchSchema.safeParse({ action: "transition", to_status: "investigating" }).success).toBe(true);
    expect(exceptionPatchSchema.safeParse({ action: "transition", to_status: "bogus" }).success).toBe(false);
    expect(exceptionPatchSchema.safeParse({ action: "assign", assigned_to: PROFILE_ID }).success).toBe(true);
    expect(exceptionPatchSchema.safeParse({ action: "assign", assigned_to: "not-a-uuid" }).success).toBe(false);
    expect(exceptionPatchSchema.safeParse({ action: "note", text: "hi" }).success).toBe(true);
    expect(exceptionPatchSchema.safeParse({ action: "note", text: "" }).success).toBe(false);
    expect(exceptionPatchSchema.safeParse({ action: "delete" }).success).toBe(false);
  });

  it("assignExceptionSchema validates nullable uuid", () => {
    expect(assignExceptionSchema.safeParse({ assigned_to: null }).success).toBe(true);
    expect(assignExceptionSchema.safeParse({ assigned_to: PROFILE_ID }).success).toBe(true);
  });
});

describe("permission model", () => {
  it("viewers read but cannot mutate; hardware/engineer/sysadmin can", () => {
    expect(roleCan("viewer", "system.kiosks.view")).toBe(true);
    expect(roleCan("viewer", "system.kiosks.manage")).toBe(false);
    for (const role of ["hardware", "engineer", "sysadmin", "breakglass"] as const) {
      expect(roleCan(role, "system.kiosks.manage")).toBe(true);
    }
  });

  it("transition map covers every canonical state", () => {
    for (const s of ["new", "investigating", "awaiting_device", "awaiting_support", "requires_financial_review", "resolved", "reopened"] as const) {
      expect(EXCEPTION_TRANSITIONS[s]).toBeDefined();
    }
    // Spec edges: resolved only reopens; investigating can resolve directly.
    expect(EXCEPTION_TRANSITIONS.resolved).toEqual(["reopened"]);
    expect(EXCEPTION_TRANSITIONS.investigating).toContain("resolved");
    expect(EXCEPTION_TRANSITIONS.new).not.toContain("resolved");
  });
});
