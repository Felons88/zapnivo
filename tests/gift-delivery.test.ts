import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { session, service, rpc, giftClaimLink, giftRedeemedConfirmation } = vi.hoisted(() => ({
  session: vi.fn(),
  service: vi.fn(),
  rpc: vi.fn(),
  giftClaimLink: vi.fn(async (_email: string, _label: string, _message: string | null, _url: string) => true),
  giftRedeemedConfirmation: vi.fn(async () => true),
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
vi.mock("@/lib/email-gifts", () => ({ giftClaimLink, giftRedeemedConfirmation }));
vi.mock("@/lib/monetization/entitlements", () => ({
  grant: vi.fn(async () => ({ ok: true, grantId: "g1" })),
  balance: vi.fn(async () => ({ cent: 0 })),
  redeem: vi.fn(), listGrants: vi.fn(async () => []), expireSweep: vi.fn(async () => 0), activeMembership: vi.fn(async () => null),
}));
vi.mock("@/lib/email-monetization", () => ({
  sendMembershipActivated: vi.fn(async () => true), sendMembershipCancelled: vi.fn(async () => true),
  sendMembershipPaymentFailed: vi.fn(async () => true), sendPackagePurchased: vi.fn(async () => true),
}));
vi.mock("@/lib/email-groups", () => ({ sendGroupFunded: vi.fn(async () => true) }));
vi.mock("@/lib/observability", () => ({ recordLog: vi.fn() }));

import {
  CLAIM_TOKEN_TTL_HOURS, claimGiftUrl, claimTokenExpiryIso, generateClaimToken, hashClaimToken,
} from "../src/lib/gifts-delivery";
import { giftSalesEnabled } from "../src/lib/gifts";
import { POST as claimPOST } from "../src/app/api/gifts/claim/route";
import { handleMonetizationEvent } from "../src/lib/monetization/webhook";
import { resetRateLimits } from "../src/lib/rate-limit";

/* ── Tiny in-memory Supabase fake (supports the ops these paths use) ────────── */
type Row = Record<string, any>;
function makeDb(tables: Record<string, Row[]> = {}) {
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const q: any = {
      _filters: [] as [string, any, string][], // [field, value, op]
      _patch: null as Row | null,
      _op: "select" as "select" | "update" | "insert",
      select: () => q,
      eq: (f: string, v: any) => { q._filters.push([f, v, "eq"]); return q; },
      is: (f: string, v: any) => { q._filters.push([f, v, "is"]); return q; },
      in: (f: string, vals: any[]) => { q._filters.push([f, vals, "in"]); return q; },
      or: () => q, order: () => q, limit: () => q,
      update: (p: Row) => { q._op = "update"; q._patch = p; return q; },
      insert: (row: Row) => { q._op = "insert"; q._insert = row; return q; },
      maybeSingle: async () => exec(true),
      single: async () => exec(true),
      then: (res: any, rej: any) => Promise.resolve(exec(false)).then(res, rej),
    };
    const match = (r: Row) => q._filters.every(([f, v, op]: [string, any, string]) => {
      if (op === "is") return v === null ? r[f] === null || r[f] === undefined : r[f] === v;
      if (op === "in") return v.includes(r[f]);
      return r[f] === v;
    });
    function exec(single: boolean) {
      if (q._op === "insert") {
        const row = { id: `${table}-${rows.length + 1}`, ...q._insert };
        rows.push(row);
        return { data: row, error: null };
      }
      if (q._op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, q._patch);
        const out = single ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r }));
        return { data: out, error: null };
      }
      const hit = rows.filter(match);
      return { data: single ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r })), error: null };
    }
    return q;
  }
  return { from, tables, rpc };
}

const CUSTOMER = { id: "user-1", email: "claimer@example.com", role: "customer", organizationId: null };
const claimReq = (token: string) =>
  new Request("http://localhost/api/gifts/claim", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
const giftEvent = (giftId: string) => ({
  type: "checkout.session.completed",
  data: { object: { id: "cs_1", payment_intent: "pi_1", metadata: { kind: "gift_credit", gift_id: giftId } } },
});
const pendingGift = (over: Row = {}): Row => ({
  id: "gift-1", status: "pending_payment", package: "Day pass gift", value_cents: 2500,
  recipient_email: "friend@example.com", message: "happy birthday", claim_token_hash: null,
  claim_token_expires_at: null, code_hash: "x", ...over,
});

beforeEach(() => {
  resetRateLimits();
  session.mockReset(); service.mockReset(); rpc.mockReset();
  giftClaimLink.mockReset(); giftClaimLink.mockResolvedValue(true);
  giftRedeemedConfirmation.mockReset(); giftRedeemedConfirmation.mockResolvedValue(true);
  session.mockResolvedValue(CUSTOMER);
  rpc.mockResolvedValue({ data: { ok: true, cents: 2500, expires_at: null }, error: null });
  vi.stubEnv("GIFT_SALES_ENABLED", "");
});
afterEach(() => vi.unstubAllEnvs());

/* ── Token primitives ──────────────────────────────────────────────────────── */
describe("claim tokens", () => {
  it("generates unique high-entropy base64url tokens and stable sha256 hashes", () => {
    const tokens = Array.from({ length: 30 }, generateClaimToken);
    expect(new Set(tokens).size).toBe(30);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const h = hashClaimToken(tokens[0]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashClaimToken(tokens[0]));
    expect(h).not.toContain(tokens[0]);
    expect(hashClaimToken("other")).not.toBe(h);
  });

  it("claimGiftUrl targets the customer claim page with ?t= and never exposes the hash", () => {
    const url = claimGiftUrl("tok.en-abc_123");
    expect(url).toContain("/account/gifts/claim?t=");
    expect(url).toContain("tok.en-abc_123");
    expect(url).not.toContain(hashClaimToken("tok.en-abc_123"));
    expect(CLAIM_TOKEN_TTL_HOURS).toBe(72);
    const exp = Date.parse(claimTokenExpiryIso());
    expect(exp).toBeGreaterThan(Date.now() + 71 * 3600_000);
    expect(exp).toBeLessThan(Date.now() + 73 * 3600_000);
  });
});

/* ── Webhook fulfillment ───────────────────────────────────────────────────── */
describe("fulfillGift secure delivery", () => {
  it("stores only the token hash + 72h expiry and emails the claim link", async () => {
    const gift = pendingGift();
    const db = makeDb({ gift_credits: [gift] });
    service.mockReturnValue(db);
    const ok = await handleMonetizationEvent(db as never, giftEvent("gift-1") as never);
    expect(ok).toBe(true);
    expect(gift.status).toBe("paid");
    expect(gift.stripe_payment_intent_id).toBe("pi_1");
    expect(gift.claim_token_hash).toMatch(/^[0-9a-f]{64}$/);
    const ttl = Date.parse(gift.claim_token_expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(71 * 3600_000);
    expect(ttl).toBeLessThan(73 * 3600_000);
    expect(giftClaimLink).toHaveBeenCalledTimes(1);
    const [email, label, message, url] = giftClaimLink.mock.calls[0];
    expect(email).toBe("friend@example.com");
    expect(label).toBe("Day pass gift");
    expect(message).toBe("happy birthday");
    expect(url).toContain("/account/gifts/claim?t=");
    // The emailed token must hash to the stored claim_token_hash.
    const token = new URL(url).searchParams.get("t")!;
    expect(hashClaimToken(token)).toBe(gift.claim_token_hash);
  });

  it("is idempotent: a webhook retry neither re-mints nor re-emails", async () => {
    const gift = pendingGift();
    const db = makeDb({ gift_credits: [gift] });
    service.mockReturnValue(db);
    await handleMonetizationEvent(db as never, giftEvent("gift-1") as never);
    const firstHash = gift.claim_token_hash;
    await handleMonetizationEvent(db as never, giftEvent("gift-1") as never);
    expect(gift.claim_token_hash).toBe(firstHash);
    expect(giftClaimLink).toHaveBeenCalledTimes(1);
  });

  it("does not mint a claim token when there is no recipient_email", async () => {
    const gift = pendingGift({ recipient_email: null });
    const db = makeDb({ gift_credits: [gift] });
    service.mockReturnValue(db);
    await handleMonetizationEvent(db as never, giftEvent("gift-1") as never);
    expect(gift.status).toBe("paid");
    expect(gift.claim_token_hash).toBeNull();
    expect(giftClaimLink).not.toHaveBeenCalled();
  });

  it("email failure never fails fulfillment", async () => {
    giftClaimLink.mockRejectedValue(new Error("smtp down"));
    const gift = pendingGift();
    const db = makeDb({ gift_credits: [gift] });
    service.mockReturnValue(db);
    await expect(handleMonetizationEvent(db as never, giftEvent("gift-1") as never)).resolves.toBe(true);
    expect(gift.status).toBe("paid");
    expect(gift.claim_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ── Claim API ─────────────────────────────────────────────────────────────── */
describe("POST /api/gifts/claim", () => {
  const claimableGift = (token: string): Row => ({
    id: "gift-1", package: "Day pass gift", status: "paid",
    claim_token_hash: hashClaimToken(token),
  });

  it("401s without a session", async () => {
    session.mockResolvedValue(null);
    service.mockReturnValue(makeDb());
    const res = await claimPOST(claimReq("sometokenvalue123"));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("404s unknown tokens generically", async () => {
    service.mockReturnValue(makeDb({ gift_credits: [claimableGift("real-token-value-123")] }));
    const res = await claimPOST(claimReq("wrong-token-value-123"));
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("claims via claim_gift RPC with hash+profile and confirms by email", async () => {
    const token = "real-token-value-123";
    const db = makeDb({ gift_credits: [claimableGift(token)] });
    service.mockReturnValue(db);
    const res = await claimPOST(claimReq(token));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toEqual({ ok: true, cents: 2500, expires_at: null });
    expect(rpc).toHaveBeenCalledWith("claim_gift", { p_token_hash: hashClaimToken(token), p_profile: "user-1" });
    expect(giftRedeemedConfirmation).toHaveBeenCalledWith("claimer@example.com", "Day pass gift", 2500);
  });

  it("maps RPC errors: expired→410, unavailable→409, no_value→422, invalid_token→404", async () => {
    const token = "real-token-value-123";
    service.mockReturnValue(makeDb({ gift_credits: [claimableGift(token)] }));
    for (const [rpcError, status] of [["expired", 410], ["unavailable", 409], ["no_value", 422], ["invalid_token", 404]] as const) {
      rpc.mockResolvedValueOnce({ data: { ok: false, error: rpcError }, error: null });
      const res = await claimPOST(claimReq(token));
      expect(res.status).toBe(status);
    }
    expect(giftRedeemedConfirmation).not.toHaveBeenCalled();
  });

  it("503s when the RPC itself errors", async () => {
    const token = "real-token-value-123";
    service.mockReturnValue(makeDb({ gift_credits: [claimableGift(token)] }));
    rpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    expect((await claimPOST(claimReq(token))).status).toBe(503);
  });
});

/* ── Sales gate unchanged ──────────────────────────────────────────────────── */
describe("gift sales gate", () => {
  it("stays disabled by default (secure delivery does not open sales)", () => {
    expect(giftSalesEnabled()).toBe(false);
    vi.stubEnv("GIFT_SALES_ENABLED", "1");
    expect(giftSalesEnabled()).toBe(true);
    vi.stubEnv("GIFT_SALES_ENABLED", "");
    expect(giftSalesEnabled()).toBe(false);
  });
});
