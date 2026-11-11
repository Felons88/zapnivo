import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { session, service, checkout, grant, balance } = vi.hoisted(() => ({
  session: vi.fn(),
  service: vi.fn(),
  checkout: vi.fn(),
  grant: vi.fn(),
  balance: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: session,
  isStaff: (u: { role?: string } | null) => u?.role === "admin" || u?.role === "staff",
  SESSION_COOKIE: "zapnivo_access",
  ANCHOR_COOKIE: "zapnivo_anchor",
  DEV_COOKIE: "zapnivo_dev_as",
  DEV_USERS: {},
  devAuth: () => false,
  authConfigured: () => true,
  SESSION_MAX_AGE_MS: 86_400_000,
  jwtSessionId: () => null,
  jwtIssuedAt: () => null,
  makeAnchorCookie: () => null,
  verifyAnchorCookie: () => null,
  revokeCurrentSession: async () => undefined,
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: service, anonClient: () => null, backendConfigured: () => true }));
vi.mock("@/lib/monetization/checkout", () => ({ createGiftCheckout: checkout }));
vi.mock("@/lib/monetization/entitlements", () => ({
  grant, balance, redeem: vi.fn(), listGrants: vi.fn(async () => []), expireSweep: vi.fn(async () => 0), activeMembership: vi.fn(async () => null),
}));
vi.mock("@/lib/email-gifts", () => ({
  giftPurchaseConfirmation: vi.fn(async () => true),
  giftReceived: vi.fn(async () => true),
  giftRedeemedConfirmation: vi.fn(async () => true),
}));

import { generateGiftCode, giftCodeHashFor, hashGiftCode, normalizeGiftCode, GIFT_PACKAGES } from "../src/lib/gifts";
import { resetRateLimits } from "../src/lib/rate-limit";
import { POST as giftPOST, GET as giftGET } from "../src/app/api/gifts/route";
import { POST as redeemPOST } from "../src/app/api/gifts/redeem/route";
import { POST as refundPOST } from "../src/app/api/admin/gifts/[id]/refund/route";

/* ── Tiny in-memory Supabase fake ──────────────────────────────────────────── */
type Row = Record<string, any>;
function makeDb(tables: Record<string, Row[]> = {}) {
  const inserted: { table: string; row: Row }[] = [];
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const q: any = {
      _filters: [] as [string, any][],
      _patch: null as Row | null,
      _insert: null as Row | null,
      _op: "select" as "select" | "update" | "insert",
      select: () => q,
      eq: (f: string, v: any) => { q._filters.push([f, v]); return q; },
      in: (f: string, vals: any[]) => { q._filters.push([f, vals]); return q; },
      or: () => q, order: () => q, limit: () => q,
      update: (p: Row) => { q._op = "update"; q._patch = p; return q; },
      insert: (row: Row) => { q._op = "insert"; q._insert = row; return q; },
      maybeSingle: async () => exec(true),
      single: async () => exec(true),
      then: (res: any, rej: any) => Promise.resolve(exec(false)).then(res, rej),
    };
    const match = (r: Row) => q._filters.every(([f, v]: [string, any]) => (Array.isArray(v) ? v.includes(r[f]) : r[f] === v));
    function exec(single: boolean) {
      if (q._op === "insert") {
        const row = { id: `${table}-${rows.length + 1}`, ...q._insert };
        rows.push(row); inserted.push({ table, row });
        return { data: row, error: null };
      }
      if (q._op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, q._patch);
        return { data: single ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r })), error: null };
      }
      const hit = rows.filter(match);
      // Return copies like real PostgREST responses — callers must not mutate stored rows.
      return { data: single ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r })), error: null };
    }
    return q;
  }
  return { from, inserted, tables };
}

const CUSTOMER = { id: "user-1", email: "buyer@example.com", role: "customer", organizationId: null };
const ADMIN = { id: "admin-1", email: "admin@example.com", role: "admin", organizationId: null };
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/gifts", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const paidGift = (over: Row = {}): Row => ({
  id: "gift-1", code_hash: "", purchaser_email: "buyer@example.com", purchaser_profile: "user-1",
  package: "Day pass gift", value_cents: 2500, recipient_email: null, message: null,
  status: "paid", expires_at: new Date(Date.now() + 86400_000).toISOString(),
  redeemed_by: null, redeemed_rental_id: null, redeemed_at: null, attempts: 0,
  last_attempt_at: null, refunded_at: null, refunded_by: null, created_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  resetRateLimits();
  session.mockReset(); service.mockReset();
  checkout.mockReset(); grant.mockReset(); balance.mockReset();
  checkout.mockResolvedValue({ ok: true, data: { id: "cs_test_1", url: "https://checkout.stripe.com/x" } });
  grant.mockResolvedValue({ ok: true, grantId: "grant-1" });
  balance.mockResolvedValue({ cent: 2500 });
  vi.stubEnv("GIFT_SALES_ENABLED", "1");
});
afterEach(() => vi.unstubAllEnvs());

/* ── Code primitives ───────────────────────────────────────────────────────── */
describe("gift codes", () => {
  it("generates XXXX-XXXX-XXXX codes from an unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const c = generateGiftCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
    expect(new Set(Array.from({ length: 20 }, generateGiftCode)).size).toBe(20);
  });
  it("normalizes case and separators before hashing; only the hash is derivable", () => {
    const raw = generateGiftCode();
    const normalized = normalizeGiftCode(raw.toLowerCase());
    expect(normalized).toMatch(/^[A-Z2-9]{12}$/);
    expect(normalizeGiftCode(" abcd-efgh-ijkl ")).toBe("ABCDEFGHIJKL");
    const h = hashGiftCode(normalized);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(giftCodeHashFor(raw)).toBe(createHash("sha256").update(normalized).digest("hex"));
    expect(giftCodeHashFor(raw)).not.toContain(normalized);
    expect(h).not.toBe(normalized);
  });
});

/* ── Purchase route ────────────────────────────────────────────────────────── */
describe("POST /api/gifts", () => {
  it("503 gift_sales_disabled unless GIFT_SALES_ENABLED=1", async () => {
    vi.stubEnv("GIFT_SALES_ENABLED", "");
    session.mockResolvedValue(CUSTOMER);
    service.mockReturnValue(makeDb());
    const res = await giftPOST(req({ packageId: "gift-10" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("gift_sales_disabled");
  });

  it("creates a pending_payment row storing only the hash, then returns checkout url + one-time code", async () => {
    session.mockResolvedValue(CUSTOMER);
    const db = makeDb();
    service.mockReturnValue(db);
    const res = await giftPOST(req({ packageId: "gift-25", recipientEmail: "friend@example.com", message: "hi" }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.url).toBe("https://checkout.stripe.com/x");
    expect(j.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const row = db.tables.gift_credits[0];
    expect(row.status).toBe("pending_payment");
    expect(row.code_hash).toBe(giftCodeHashFor(j.code));
    expect(row.code_hash).not.toBe(j.code);
    expect(row.value_cents).toBe(2500);
    expect(row.stripe_checkout_session_id).toBe("cs_test_1");
    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({ giftId: row.id, amountCents: 2500 }));
  });

  it("rejects unknown packages and unauthenticated users", async () => {
    session.mockResolvedValue(CUSTOMER);
    service.mockReturnValue(makeDb());
    expect((await giftPOST(req({ packageId: "nope" }))).status).toBe(422);
    session.mockResolvedValue(null);
    expect((await giftPOST(req({ packageId: "gift-10" }))).status).toBe(401);
  });
});

/* ── Redeem route ──────────────────────────────────────────────────────────── */
describe("POST /api/gifts/redeem", () => {
  const redeemReq = (code: string) => req({ code });

  it("rejects unknown codes and unpaid gifts with the SAME generic error (no existence leak)", async () => {
    session.mockResolvedValue(CUSTOMER);
    const gift = paidGift({ status: "pending_payment" });
    gift.code_hash = giftCodeHashFor("ABCD-EFGH-JKLM");
    service.mockReturnValue(makeDb({ gift_credits: [gift] }));
    const bad = await redeemPOST(redeemReq("ZZZZ-ZZZZ-ZZZZ"));
    const unpaid = await redeemPOST(redeemReq("abcd-efgh-jklm"));
    expect(bad.status).toBe(422); expect(unpaid.status).toBe(422);
    expect(await bad.json()).toEqual(await unpaid.json());
    expect(gift.attempts).toBe(1); // failure counted on the real row only
    expect(gift.status).toBe("pending_payment");
  });

  it("rejects expired gifts and locks after MAX_GIFT_ATTEMPTS", async () => {
    session.mockResolvedValue(CUSTOMER);
    const expired = paidGift({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expired.code_hash = giftCodeHashFor("ABCD-EFGH-JKLM");
    const locked = paidGift({ id: "gift-2", attempts: 5 });
    locked.code_hash = giftCodeHashFor("MNOP-QRST-UVWX");
    service.mockReturnValue(makeDb({ gift_credits: [expired, locked] }));
    expect((await redeemPOST(redeemReq("abcd-efgh-jklm"))).status).toBe(422);
    expect((await redeemPOST(redeemReq("mnop-qrst-uvwx"))).status).toBe(422);
    expect(grant).not.toHaveBeenCalled();
  });

  it("redeems a paid gift: flips status, grants 'cent' credits with expiry carried over", async () => {
    session.mockResolvedValue(CUSTOMER);
    const gift = paidGift();
    gift.code_hash = giftCodeHashFor("ABCD-EFGH-JKLM");
    const db = makeDb({ gift_credits: [gift] });
    service.mockReturnValue(db);
    const res = await redeemPOST(redeemReq("abcd efgh jklm")); // separators/case ignored
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.credit_cents).toBe(2500);
    expect(j.balance_cents).toBe(2500);
    expect(gift.status).toBe("redeemed");
    expect(gift.redeemed_by).toBe("user-1");
    expect(gift.redeemed_at).toBeTruthy();
    expect(grant).toHaveBeenCalledWith(db, expect.objectContaining({
      profileId: "user-1", kind: "gift", unit: "cent", amount: 2500,
      expiresAt: gift.expires_at, sourceType: "gift_credit", sourceId: "gift-1",
    }));
  });

  it("concurrent redeems of the same code: exactly one wins", async () => {
    session.mockResolvedValue(CUSTOMER);
    const gift = paidGift();
    gift.code_hash = giftCodeHashFor("ABCD-EFGH-JKLM");
    service.mockReturnValue(makeDb({ gift_credits: [gift] }));
    const [a, b] = await Promise.all([redeemPOST(redeemReq("ABCD-EFGH-JKLM")), redeemPOST(redeemReq("ABCD-EFGH-JKLM"))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 422]);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it("rolls the status back to 'paid' when the grant fails", async () => {
    session.mockResolvedValue(CUSTOMER);
    grant.mockResolvedValue({ ok: false, error: "rpc down" });
    const gift = paidGift();
    gift.code_hash = giftCodeHashFor("ABCD-EFGH-JKLM");
    service.mockReturnValue(makeDb({ gift_credits: [gift] }));
    const res = await redeemPOST(redeemReq("ABCD-EFGH-JKLM"));
    expect(res.status).toBe(503);
    expect(gift.status).toBe("paid");
    expect(gift.redeemed_by).toBeNull();
  });
});

/* ── Admin refund ──────────────────────────────────────────────────────────── */
describe("POST /api/admin/gifts/[id]/refund", () => {
  const GID = "11111111-1111-4111-8111-111111111111";
  const refundReq = () => new Request(`http://localhost/api/admin/gifts/${GID}/refund`, {
    method: "POST", headers: { accept: "application/json" },
  });
  const ctx = { params: Promise.resolve({ id: GID }) };

  it("staff-only, and refuses non-paid gifts", async () => {
    session.mockResolvedValue(CUSTOMER);
    service.mockReturnValue(makeDb());
    expect((await refundPOST(refundReq(), ctx)).status).toBe(403);
    session.mockResolvedValue(ADMIN);
    const pending = paidGift({ id: GID, status: "pending_payment" });
    service.mockReturnValue(makeDb({ gift_credits: [pending] }));
    const res = await refundPOST(refundReq(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("error");
    expect(pending.status).toBe("pending_payment");
  });

  it("refunds a redeemed gift and revokes its cent grant with an audit event", async () => {
    session.mockResolvedValue(ADMIN);
    const gift = paidGift({ id: GID, status: "redeemed", redeemed_by: "user-9", redeemed_at: new Date().toISOString() });
    const grantRow = { id: "grant-9", profile_id: "user-9", remaining: 2500, status: "active", source_type: "gift_credit", source_id: GID };
    const db = makeDb({
      gift_credits: [gift],
      entitlement_grants: [grantRow],
      entitlement_events: [],
      audit_logs: [],
    });
    service.mockReturnValue(db);
    const res = await refundPOST(refundReq(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("refunded");
    expect(gift.status).toBe("refunded");
    expect(gift.refunded_by).toBe("admin-1");
    expect(grantRow.status).toBe("revoked");
    expect(grantRow.remaining).toBe(0);
    const ev = db.tables.entitlement_events[0];
    expect(ev.event).toBe("revoke");
    expect(ev.delta).toBe(-2500);
    expect(ev.ref_type).toBe("gift");
    expect(ev.ref_id).toBe(GID);
    expect(db.tables.audit_logs[0].action).toBe("refund_gift");
  });
});

/* ── GET never leaks code_hash ─────────────────────────────────────────────── */
describe("GET /api/gifts", () => {
  it("returns purchased + redeemed gifts without code_hash", async () => {
    session.mockResolvedValue(CUSTOMER);
    const gift = paidGift();
    gift.code_hash = "secret-hash";
    const purchased = paidGift({ id: "gift-2", status: "redeemed", redeemed_by: "user-1", redeemed_at: new Date().toISOString() });
    purchased.code_hash = "secret-hash-2";
    service.mockReturnValue(makeDb({ gift_credits: [gift, purchased] }));
    const res = await giftGET();
    expect(res.status).toBe(200);
    const j = await res.json();
    const all = [...j.purchased, ...j.redeemed];
    expect(all.length).toBeGreaterThan(0);
    expect(JSON.stringify(j)).not.toContain("code_hash");
    expect(JSON.stringify(j)).not.toContain("secret-hash");
  });
});
