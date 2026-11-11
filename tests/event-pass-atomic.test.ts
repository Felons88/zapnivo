import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashPassCode, redeemPass } from "@/lib/events-program";

/* ── RPC-contract fake ────────────────────────────────────────────────────
 * redeemPass must do ALL work inside the redeem_event_pass RPC (migration
 * 0034). This fake records every rpc() and from() call; any from() usage is
 * poisoned so the test fails if the old claim/grant/revert path returns. */

type Row = Record<string, any>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function spyDb(rpcImpl?: (fn: string, args: Row) => { data?: unknown; error?: { message: string } | null }) {
  const rpcCalls: { fn: string; args: Row }[] = [];
  const fromCalls: { table: string; op: string }[] = [];
  const db = {
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      return rpcImpl ? rpcImpl(fn, args) : { data: 2, error: null };
    },
    from: (table: string) => {
      const rec = { table, op: "select" };
      fromCalls.push(rec);
      const poisoned = { data: null, error: { message: `unexpected from('${table}') — must use RPC` } };
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.select = chain; q.eq = chain; q.neq = chain; q.in = chain; q.is = chain;
      q.not = chain; q.order = chain; q.limit = chain;
      q.insert = () => { rec.op = "insert"; return q; };
      q.update = () => { rec.op = "update"; return q; };
      q.delete = () => { rec.op = "delete"; return q; };
      q.single = async () => poisoned;
      q.maybeSingle = async () => poisoned;
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(poisoned).then(res, rej);
      return q;
    },
  };
  return { db: db as never, rpcCalls, fromCalls };
}

const PROFILE = "33333333-3333-4333-8333-333333333333";
const CODE = "ABCD-EFGH-JKLM";

describe("redeem_event_pass RPC contract", () => {
  it("calls redeem_event_pass with hashed code + profile and returns rentals", async () => {
    const { db, rpcCalls } = spyDb(() => ({ data: 4, error: null }));
    const r = await redeemPass(db, PROFILE, ` ${CODE.toLowerCase()} `);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rentals).toBe(4);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("redeem_event_pass");
    expect(rpcCalls[0].args).toEqual({
      p_code_hash: sha(CODE),
      p_profile: PROFILE,
    });
    // Raw code must never leave the client boundary into RPC args.
    expect(JSON.stringify(rpcCalls[0].args)).not.toContain(CODE);
    expect(rpcCalls[0].args.p_code_hash).toBe(hashPassCode(CODE));
  });

  it("maps every coded RPC exception to the agreed error/status", async () => {
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
      const { db } = spyDb(() => ({ data: null, error: { message: rpcMsg } }));
      const r = await redeemPass(db, PROFILE, CODE);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe(error);
        expect(r.status).toBe(status);
      }
    }
    const { db } = spyDb(() => ({ data: null, error: { message: "deadlock detected" } }));
    const r = await redeemPass(db, PROFILE, CODE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("redeem_failed");
      expect(r.status).toBe(500);
    }
  });

  it("performs NO direct table writes — claim/grant/audit are all inside the RPC", async () => {
    const { db, fromCalls } = spyDb(() => ({ data: 1, error: null }));
    const r = await redeemPass(db, PROFILE, CODE);
    expect(r.ok).toBe(true);
    // The whole point of the RPC: redeemPass must not touch event_passes,
    // entitlement_grants, or entitlement_events directly — not even reads.
    expect(fromCalls).toHaveLength(0);
    const writes = fromCalls.filter((c) => c.op === "insert" || c.op === "update" || c.op === "delete");
    expect(writes).toHaveLength(0);
    for (const table of ["event_passes", "entitlement_grants", "entitlement_events", "event_programs"]) {
      expect(fromCalls.filter((c) => c.table === table)).toHaveLength(0);
    }
  });

  it("rejects malformed codes client-side without any RPC call", async () => {
    const { db, rpcCalls } = spyDb();
    for (const bad of ["", "!!", "ab", "x".repeat(40), "has spaces here!"]) {
      const r = await redeemPass(db, PROFILE, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(422);
    }
    expect(rpcCalls).toHaveLength(0);
  });
});
