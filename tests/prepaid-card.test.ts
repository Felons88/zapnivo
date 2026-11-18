import { describe, expect, it } from "vitest";
import { cardCvc, expiryEnd, expiryFor, formatExpiry, formatPan, generatePan, getOrIssueCard, isExpired, luhnValid, maskedPan } from "@/lib/prepaid-card";

type Row = Record<string, unknown>;
function fakeDb(rows: Row[]) {
  return {
    from() {
      let list = [...rows];
      let pending: Row | null = null;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { list = list.filter((r) => r[c] === v); return b; };
      b.in = (c: string, vs: unknown[]) => { list = list.filter((r) => vs.includes(r[c])); return b; };
      b.maybeSingle = async () => ({ data: list[0] ?? null, error: null });
      b.single = async () => ({ data: pending, error: pending ? null : { message: "x" } });
      b.insert = (row: Row) => { pending = { id: `c${rows.length + 1}`, status: "active", issued_at: "2026-01-01T00:00:00Z", ...row }; rows.push(pending); return b; };
      b.update = (patch: Row) => ({ eq: (_c: string, id: unknown) => { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, patch); return Promise.resolve({ error: null }); } });
      return b;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("prepaid card", () => {
  it("generates Luhn-valid 16-digit Zapnivo-only numbers", () => {
    for (let i = 0; i < 50; i++) {
      const pan = generatePan();
      expect(pan).toMatch(/^9701\d{12}$/);
      expect(luhnValid(pan)).toBe(true);
    }
    expect(new Set(Array.from({ length: 50 }, generatePan)).size).toBe(50);
  });

  it("expires on the last day of the issue month, five years out", () => {
    const exp = expiryFor(new Date("2026-11-17T12:00:00Z"));
    expect(exp).toEqual({ month: 11, year: 2031 });
    expect(expiryEnd(11, 2031).toISOString()).toBe("2031-11-30T23:59:59.999Z");
    expect(isExpired({ exp_month: 11, exp_year: 2031 }, new Date("2031-11-30T23:00:00Z"))).toBe(false);
    expect(isExpired({ exp_month: 11, exp_year: 2031 }, new Date("2031-12-01T00:00:01Z"))).toBe(true);
    expect(formatExpiry({ exp_month: 3, exp_year: 2031 })).toBe("03/31");
  });

  it("derives a stable 3-digit code that changes with the card", () => {
    const a = { pan: "9701123412341234", exp_month: 1, exp_year: 2031 };
    expect(cardCvc(a)).toMatch(/^\d{3}$/);
    expect(cardCvc(a)).toBe(cardCvc({ ...a }));
    expect(cardCvc({ ...a, pan: "9701123412341235" })).not.toBeNull();
  });

  it("formats and masks", () => {
    expect(formatPan("9701123412341234")).toBe("9701 1234 1234 1234");
    expect(maskedPan("9701123412341234")).toBe("•••• •••• •••• 1234");
  });

  it("issues once, reuses it, and replaces an expired card", async () => {
    const rows: Row[] = [];
    const db = fakeDb(rows);
    const first = await getOrIssueCard(db, "p1", new Date("2026-11-17T00:00:00Z"));
    const again = await getOrIssueCard(db, "p1", new Date("2026-12-01T00:00:00Z"));
    expect(again?.id).toBe(first?.id);
    expect(rows).toHaveLength(1);
    const renewed = await getOrIssueCard(db, "p1", new Date("2032-01-01T00:00:00Z"));
    expect(renewed?.id).not.toBe(first?.id);
    expect(rows.find((r) => r.id === first?.id)?.status).toBe("expired");
    expect(renewed?.exp_year).toBe(2037);
  });
});
