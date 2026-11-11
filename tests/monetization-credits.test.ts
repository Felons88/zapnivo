import { describe, expect, it } from "vitest";
import { applyCreditsAtSettlement, openReservations, releaseForRental, reserveForRental, spendable } from "@/lib/monetization/credits";
import { PRICING_V1, type PricingVersion } from "@/lib/pricing";

type Row = Record<string, unknown>;

/** Minimal fake: `from("entitlement_reservations")` returns seeded rows; rpc is recorded. */
function fakeDb(reservations: Row[] = [], grants: Row[] = []) {
  const rpcCalls: { fn: string; args: Row }[] = [];
  const db = {
    from: (table: string) => {
      const filters: ((r: Row) => boolean)[] = [];
      const q: Record<string, unknown> = {};
      const rows = () => (table === "entitlement_reservations" ? reservations : table === "entitlement_grants" ? grants : []).filter((r) => filters.every((f) => f(r)));
      q.select = () => q;
      q.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; };
      q.update = () => q;
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res);
      return q;
    },
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      if (fn === "release_rental_reservations") return { data: 1, error: null };
      return { data: "res-1", error: null };
    },
  };
  return { db: db as never, rpcCalls };
}

const pricing: PricingVersion = { ...PRICING_V1, approved: true, additionalDayCents: 1677 };
const HOLD = 4500; // nonReturnMaxCents × 1 bank

describe("spendable", () => {
  it("sums remaining minus reserved per unit", async () => {
    const { db } = fakeDb([], [
      { profile_id: "p1", unit: "cent", remaining: 1000, reserved: 200, status: "active" },
      { profile_id: "p1", unit: "cent", remaining: 500, reserved: 0, status: "active" },
      { profile_id: "p1", unit: "rental", remaining: 2, reserved: 1, status: "active" },
    ]);
    const s = await spendable(db, "p1");
    expect(s.cent).toBe(1300);
    expect(s.rental).toBe(1);
    expect(s.minute).toBe(0);
  });
});

describe("reserveForRental", () => {
  it("reserves cent up to hold, enough minutes for hold, and one rental unit", async () => {
    const { db, rpcCalls } = fakeDb([], [
      { profile_id: "p1", unit: "cent", remaining: 99999, reserved: 0, status: "active" },
      { profile_id: "p1", unit: "minute", remaining: 9999, reserved: 0, status: "active" },
      { profile_id: "p1", unit: "rental", remaining: 5, reserved: 0, status: "active" },
    ]);
    await reserveForRental(db, "p1", "r1", { holdCents: HOLD, pricing });
    const calls = rpcCalls.filter((c) => c.fn === "reserve_entitlement");
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toMatchObject({ p_profile: "p1", p_unit: "cent", p_amount: HOLD, p_rental_id: "r1" });
    // minutes to cover $45 hold at $6.99/hr ≈ 387 minutes
    expect(calls[1].args.p_unit).toBe("minute");
    expect((calls[1].args.p_amount as number)).toBeGreaterThan(380);
    expect(calls[2].args).toMatchObject({ p_unit: "rental", p_amount: 1 });
  });

  it("skips units with zero balance and never reserves more than available", async () => {
    const { db, rpcCalls } = fakeDb([], [{ profile_id: "p1", unit: "cent", remaining: 300, reserved: 0, status: "active" }]);
    await reserveForRental(db, "p1", "r1", { holdCents: HOLD, pricing });
    const calls = rpcCalls.filter((c) => c.fn === "reserve_entitlement");
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_amount).toBe(300);
  });
});

describe("applyCreditsAtSettlement", () => {
  it("applies cent → minute → rental in order and releases the remainder", async () => {
    // total $10.00; cent reservation $4, minute reservation 100min, rental 1
    const res = [
      { id: "rc", grant_id: "g1", rental_id: "r1", profile_id: "p1", unit: "cent", amount: 400, status: "reserved" },
      { id: "rm", grant_id: "g2", rental_id: "r1", profile_id: "p1", unit: "minute", amount: 100, status: "reserved" },
      { id: "rr", grant_id: "g3", rental_id: "r1", profile_id: "p1", unit: "rental", amount: 1, status: "reserved" },
    ];
    const { db, rpcCalls } = fakeDb(res);
    const applied = await applyCreditsAtSettlement(db, "r1", "p1", 1000, pricing, "staff:test");
    expect(applied).toBe(1000);
    const commits = rpcCalls.filter((c) => c.fn.startsWith("commit_entitlement"));
    // cent partial commit 400; minute partial commit covers remaining 600 → 52 min; rental untouched
    expect(commits.find((c) => c.args.p_reservation_id === "rc")?.args.p_amount).toBe(400);
    const mc = commits.find((c) => c.args.p_reservation_id === "rm");
    expect(mc?.fn).toBe("commit_entitlement_partial");
    expect(mc?.args.p_amount).toBe(52); // minutes, not cents
    expect(commits.find((c) => c.args.p_reservation_id === "rr")).toBeUndefined();
    expect(rpcCalls.some((c) => c.fn === "release_rental_reservations")).toBe(true);
  });

  it("uses the rental unit when cents+minutes can't cover the charge", async () => {
    const res = [
      { id: "rc", grant_id: "g1", rental_id: "r1", profile_id: "p1", unit: "cent", amount: 200, status: "reserved" },
      { id: "rr", grant_id: "g3", rental_id: "r1", profile_id: "p1", unit: "rental", amount: 1, status: "reserved" },
    ];
    const { db, rpcCalls } = fakeDb(res);
    const applied = await applyCreditsAtSettlement(db, "r1", "p1", 1000, pricing, "staff:test");
    expect(applied).toBe(1000);
    expect(rpcCalls.some((c) => c.fn === "commit_entitlement" && c.args.p_reservation_id === "rr")).toBe(true);
  });

  it("applies only what exists and releases the rest when credits are insufficient", async () => {
    const res = [{ id: "rc", grant_id: "g1", rental_id: "r1", profile_id: "p1", unit: "cent", amount: 250, status: "reserved" }];
    const { db, rpcCalls } = fakeDb(res);
    const applied = await applyCreditsAtSettlement(db, "r1", "p1", 1000, pricing, "staff:test");
    expect(applied).toBe(250);
    expect(rpcCalls.find((c) => c.fn === "commit_entitlement_partial")?.args.p_amount).toBe(250);
    expect(rpcCalls.some((c) => c.fn === "release_rental_reservations")).toBe(true);
  });

  it("releases reservations and applies nothing for zero-total or guest rentals", async () => {
    const { db: d1, rpcCalls: r1 } = fakeDb([{ id: "rc", grant_id: "g", rental_id: "r1", profile_id: "p1", unit: "cent", amount: 100, status: "reserved" }]);
    expect(await applyCreditsAtSettlement(d1, "r1", "p1", 0, pricing, "staff:test")).toBe(0);
    expect(r1.some((c) => c.fn === "release_rental_reservations")).toBe(true);

    const { db: d2, rpcCalls: r2 } = fakeDb([{ id: "rc", grant_id: "g", rental_id: "r1", profile_id: "p1", unit: "cent", amount: 100, status: "reserved" }]);
    expect(await applyCreditsAtSettlement(d2, "r1", null, 1000, pricing, "staff:test")).toBe(0);
    expect(r2.some((c) => c.fn === "release_rental_reservations")).toBe(true);
    expect(r2.some((c) => c.fn.startsWith("commit"))).toBe(false);
  });
});

describe("releaseForRental / openReservations", () => {
  it("delegates to release_rental_reservations and returns the count", async () => {
    const { db, rpcCalls } = fakeDb();
    expect(await releaseForRental(db, "r9")).toBe(1);
    expect(rpcCalls[0]).toMatchObject({ fn: "release_rental_reservations", args: { p_rental_id: "r9" } });
  });

  it("lists only open reservations for the rental", async () => {
    const { db } = fakeDb([
      { id: "a", rental_id: "r1", profile_id: "p1", unit: "cent", amount: 5, status: "reserved" },
      { id: "b", rental_id: "r1", profile_id: "p1", unit: "cent", amount: 5, status: "released" },
      { id: "c", rental_id: "r2", profile_id: "p1", unit: "cent", amount: 5, status: "reserved" },
    ]);
    const rows = await openReservations(db, "r1");
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });
});
