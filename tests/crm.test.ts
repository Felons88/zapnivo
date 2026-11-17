import { describe, expect, it } from "vitest";
import { loadCustomer360, searchCustomers } from "@/lib/crm";

/**
 * Customer 360: unified search must find one identity across profiles, tickets,
 * payments and rentals — by name, email, any phone format, or rental reference —
 * and the 360 loader must merge profile-linked and receipt-linked rentals.
 */

type Row = Record<string, unknown>;

const ilikeToRe = (pat: string) => new RegExp("^" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");

/** Split an or() expression on top-level commas only — in.(a,b) lists contain commas. */
function splitOr(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function matchCond(row: Row, cond: string): boolean {
  const m = cond.trim().match(/^([a-zA-Z_]+)\.(eq|neq|in|ilike)\.(.+)$/);
  if (!m) return false;
  const [, col, op, raw] = m;
  const cell = row[col];
  if (op === "ilike") return ilikeToRe(raw).test(String(cell ?? ""));
  if (op === "in") {
    const inner = raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw;
    return inner.split(",").map((v) => v.trim()).includes(String(cell));
  }
  const val = raw === "null" ? null : raw;
  return op === "eq" ? String(cell) === val : String(cell) !== val;
}
const matchOr = (row: Row, expr: string) => splitOr(expr).some((c) => matchCond(row, c));

function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; };
      b.in = (c: string, vals: unknown[]) => { rows = rows.filter((r) => vals.map(String).includes(String(r[c]))); return b; };
      b.or = (expr: string) => { rows = rows.filter((r) => matchOr(r, expr)); return b; };
      b.ilike = (c: string, pat: string) => { const re = ilikeToRe(pat); rows = rows.filter((r) => re.test(String(r[c] ?? ""))); return b; };
      b.order = () => b;
      b.limit = (n: number) => { rows = rows.slice(0, n); return b; };
      b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res, rej);
      return b;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const A_ID = "11111111-1111-1111-1111-111111111111";

const TABLES: Record<string, Row[]> = {
  profiles: [
    { id: A_ID, email: "amy@example.com", full_name: "Amy Example", phone: "+13205550111", role: "customer", notify_sms: true, created_at: "2026-01-01T00:00:00Z" },
    { id: "22222222-2222-2222-2222-222222222222", email: "ben@example.com", full_name: "Ben Example", phone: null, role: "customer", notify_sms: false, created_at: "2026-01-01T00:00:00Z" },
  ],
  rentals: [
    { id: "r-1", reference: "ZR-AAAA1111", state: "active", customer_id: A_ID, renter_profile: null, created_at: "2026-11-08T18:00:00Z", started_at: null, dispensed_at: null, returned_at: null, non_return_deadline: null, kiosks: { station_id: "ZP-001", venues: { name: "Riverside Tavern", city: "St. Cloud" } }, payments: [{ id: "p-1", state: "captured", amount_captured_cents: 1299, amount_authorized_cents: 500, amount_refunded_cents: 0, tax_cents: 0, receipt_email: "amy@example.com", customer_phone: "+13205550111", created_at: "2026-11-08T18:00:00Z" }] },
    { id: "r-2", reference: "ZR-BBBB2222", state: "returned", customer_id: null, renter_profile: null, created_at: "2026-11-07T20:00:00Z", started_at: null, dispensed_at: null, returned_at: "2026-11-07T22:00:00Z", non_return_deadline: null, kiosks: null, payments: [{ id: "p-2", state: "captured", amount_captured_cents: 999, amount_authorized_cents: 500, amount_refunded_cents: 0, tax_cents: 0, receipt_email: "ben@example.com", customer_phone: null, created_at: "2026-11-07T20:00:00Z" }] },
    { id: "r-3", reference: "ZR-CCCC3333", state: "unreturned", customer_id: null, renter_profile: null, created_at: "2026-11-05T10:00:00Z", started_at: null, dispensed_at: null, returned_at: null, non_return_deadline: null, kiosks: null, payments: [{ id: "p-3", state: "captured", amount_captured_cents: 700, amount_authorized_cents: 500, amount_refunded_cents: 0, tax_cents: 0, receipt_email: "amy@example.com", customer_phone: null, created_at: "2026-11-05T10:00:00Z" }] },
    // Guest rental where the receipt email was typo'd — only links back via the checkout phone.
    { id: "r-4", reference: "ZR-DDDD4444", state: "overdue", customer_id: null, renter_profile: null, created_at: "2026-11-10T09:00:00Z", started_at: null, dispensed_at: null, returned_at: null, non_return_deadline: null, kiosks: null, payments: [{ id: "p-4", state: "authorized", amount_captured_cents: null, amount_authorized_cents: 500, amount_refunded_cents: 0, tax_cents: 0, receipt_email: "amy-typo@example.com", customer_phone: "(320) 555-0111", created_at: "2026-11-10T09:00:00Z" }] },
  ],
  payments: [
    { id: "p-1", rental_id: "r-1", receipt_email: "amy@example.com", customer_phone: "+13205550111", created_at: "2026-11-08T18:00:00Z" },
    { id: "p-2", rental_id: "r-2", receipt_email: "ben@example.com", customer_phone: null, created_at: "2026-11-07T20:00:00Z" },
    { id: "p-3", rental_id: "r-3", receipt_email: "amy@example.com", customer_phone: null, created_at: "2026-11-05T10:00:00Z" },
    { id: "p-4", rental_id: "r-4", receipt_email: "amy-typo@example.com", customer_phone: "(320) 555-0111", created_at: "2026-11-10T09:00:00Z" },
  ],
  support_tickets: [
    { id: "t-1", ticket_number: "Z-1001", email: "amy@example.com", name: "Amy Example", phone: "(320) 555-0111", category: "Other", state: "open", priority: "normal", rental_ref: "ZR-AAAA1111", created_at: "2026-11-09T00:00:00Z" },
    { id: "t-2", ticket_number: "Z-1002", email: "amy@example.com", name: "Amy E.", phone: null, category: "Billing question", state: "resolved", priority: "normal", rental_ref: null, created_at: "2026-11-01T00:00:00Z" },
  ],
  customer_notes: [{ id: "n-1", customer_email: "amy@example.com", body: "Prefers SMS.", author: A_ID, created_at: "2026-11-09T01:00:00Z" }],
  customer_data_requests: [],
  incident_reports: [{ id: "i-1", rental_id: "r-3", kind: "lost", description: "Customer says it was stolen", created_at: "2026-11-06T00:00:00Z" }],
  refund_requests: [{ id: "rf-1", ticket_id: "t-1", rental_ref: "ZR-AAAA1111", reason: "overcharge", amount_cents: 500, status: "requested", created_at: "2026-11-09T02:00:00Z" }],
  disputes: [],
  sms_messages: [{ id: "s-1", direction: "outbound", to_number: "+13205550111", from_number: "+15550001111", body: "Your rental receipt", status: "sent", created_at: "2026-11-08T18:01:00Z" }],
};

const db = fakeDb(TABLES);

describe("searchCustomers", () => {
  it("finds a customer by name", async () => {
    const res = await searchCustomers(db, "amy example");
    expect(res.map((r) => r.email)).toContain("amy@example.com");
    const amy = res.find((r) => r.email === "amy@example.com")!;
    expect(amy.hasAccount).toBe(true);
    expect(amy.rentalCount).toBe(2); // r-1 via profile, r-3 via receipt email (r-4's receipt email differs)
    expect(amy.openTickets).toBe(1);
  });

  it("finds a customer by phone in any format", async () => {
    for (const q of ["+13205550111", "(320) 555-0111", "3205550111"]) {
      const res = await searchCustomers(db, q);
      expect(res.map((r) => r.email), `query ${q}`).toContain("amy@example.com");
    }
  });

  it("finds a guest-only customer by receipt email", async () => {
    const res = await searchCustomers(db, "ben@example.com");
    const ben = res.find((r) => r.email === "ben@example.com")!;
    expect(ben.hasAccount).toBe(true); // ben has a profile in fixtures
    expect(ben.rentalCount).toBe(1);
  });

  it("resolves a rental reference to the customer", async () => {
    const res = await searchCustomers(db, "ZR-CCCC3333");
    expect(res.map((r) => r.email)).toContain("amy@example.com");
    const res2 = await searchCustomers(db, "zrcccc3333");
    expect(res2.map((r) => r.email)).toContain("amy@example.com");
  });

  it("returns nothing for junk queries", async () => {
    expect(await searchCustomers(db, "x")).toEqual([]);
    expect(await searchCustomers(db, "nobody-here-zzz")).toEqual([]);
  });
});

describe("loadCustomer360", () => {
  it("merges profile-linked, receipt-linked and phone-linked rentals", async () => {
    const c = await loadCustomer360(db, "amy@example.com");
    expect(c).not.toBeNull();
    // r-4's receipt email was typo'd — it only links via the checkout phone matching the profile.
    expect(c!.rentals.map((r) => r.reference).sort()).toEqual(["ZR-AAAA1111", "ZR-CCCC3333", "ZR-DDDD4444"]);
    expect(c!.totals.capturedCents).toBe(1299 + 700);
    expect(c!.totals.activeRentals).toBe(3); // active + unreturned + overdue
    expect(c!.totals.openTickets).toBe(1);
  });

  it("collects names, phones, notes, incidents, refunds and sms", async () => {
    const c = (await loadCustomer360(db, "amy@example.com"))!;
    expect(c.profile?.id).toBe(A_ID);
    expect(c.names).toContain("Amy Example");
    expect(c.phones).toContain("+13205550111");
    expect(c.phones).toContain("(320) 555-0111");
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0].author_email).toBe("amy@example.com");
    expect(c.incidents).toHaveLength(1);
    expect(c.refundRequests).toHaveLength(1);
    expect(c.sms).toHaveLength(1);
    expect(c.tickets).toHaveLength(2);
  });

  it("rejects non-email keys", async () => {
    expect(await loadCustomer360(db, "not-an-email")).toBeNull();
    expect(await loadCustomer360(db, "")).toBeNull();
  });
});
