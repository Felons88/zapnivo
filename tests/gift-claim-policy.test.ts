import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  session, service, rpc, giftClaimLink, giftRedeemedConfirmation,
  signInWithOAuth, signInWithOtp, exchangeCodeForSession, generateLink,
} = vi.hoisted(() => ({
  session: vi.fn(),
  service: vi.fn(),
  rpc: vi.fn(),
  giftClaimLink: vi.fn(async () => true),
  giftRedeemedConfirmation: vi.fn(async () => true),
  signInWithOAuth: vi.fn(),
  signInWithOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  generateLink: vi.fn(),
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
vi.mock("@/lib/supabase", () => ({
  serviceClient: service,
  anonClient: () => null,
  backendConfigured: () => true,
  oauthClient: () => ({
    client: {
      auth: {
        signInWithOAuth,
        signInWithOtp,
        exchangeCodeForSession,
        admin: { generateLink },
      },
    },
    apply: <T>(res: T): T => res,
  }),
}));
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

import { safeNext, withNextParam, postAuthDestination } from "../src/lib/auth-next";
import { GIFT_LAUNCH_CHECKLIST, giftLaunchStatus } from "../src/lib/gift-launch";
import { hashClaimToken } from "../src/lib/gifts-delivery";
import { POST as claimPOST } from "../src/app/api/gifts/claim/route";
import { handleMonetizationEvent } from "../src/lib/monetization/webhook";
import { resetRateLimits } from "../src/lib/rate-limit";

/* ── Tiny in-memory Supabase fake (same ops as gift-delivery.test.ts) ───────── */
type Row = Record<string, any>;
function makeDb(tables: Record<string, Row[]> = {}) {
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const q: any = {
      _filters: [] as [string, any, string][],
      _patch: null as Row | null,
      _op: "select" as "select" | "update" | "insert" | "delete",
      select: () => q,
      eq: (f: string, v: any) => { q._filters.push([f, v, "eq"]); return q; },
      is: (f: string, v: any) => { q._filters.push([f, v, "is"]); return q; },
      in: (f: string, vals: any[]) => { q._filters.push([f, vals, "in"]); return q; },
      gt: (f: string, v: any) => { q._filters.push([f, v, "gt"]); return q; },
      not: () => q,
      or: () => q, order: () => q, limit: () => q,
      update: (p: Row) => { q._op = "update"; q._patch = p; return q; },
      insert: (row: Row) => { q._op = "insert"; q._insert = row; return q; },
      delete: () => { q._op = "delete"; return q; },
      maybeSingle: async () => exec(true),
      single: async () => exec(true),
      then: (res: any, rej: any) => Promise.resolve(exec(false)).then(res, rej),
    };
    const match = (r: Row) => q._filters.every(([f, v, op]: [string, any, string]) => {
      if (op === "is") return v === null ? r[f] === null || r[f] === undefined : r[f] === v;
      if (op === "in") return v.includes(r[f]);
      if (op === "gt") return String(r[f] ?? "") > String(v);
      return r[f] === v;
    });
    function exec(single: boolean) {
      if (q._op === "insert") {
        const row = { id: `${table}-${rows.length + 1}`, ...q._insert };
        rows.push(row);
        return { data: row, error: null };
      }
      if (q._op === "delete") {
        const hit = rows.filter(match);
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { data: null, error: null };
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
  recipient_email: "friend@example.com", message: null, claim_token_hash: null,
  claim_token_expires_at: null, claim_policy: "bearer", code_hash: "x", ...over,
});
const claimableGift = (token: string, over: Row = {}): Row => ({
  id: "gift-1", package: "Day pass gift", status: "paid",
  claim_token_hash: hashClaimToken(token), ...over,
});

beforeEach(() => {
  resetRateLimits();
  session.mockReset(); service.mockReset(); rpc.mockReset();
  giftClaimLink.mockReset(); giftClaimLink.mockResolvedValue(true);
  giftRedeemedConfirmation.mockReset(); giftRedeemedConfirmation.mockResolvedValue(true);
  signInWithOAuth.mockReset(); signInWithOtp.mockReset(); exchangeCodeForSession.mockReset(); generateLink.mockReset();
  session.mockResolvedValue(CUSTOMER);
  rpc.mockResolvedValue({ data: { ok: true, cents: 2500, expires_at: null }, error: null });
  vi.stubEnv("GIFT_SALES_ENABLED", "");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

/* ── Migration file ────────────────────────────────────────────────────────── */
describe("migration 0040 gift claim policy", () => {
  const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "0040_gift_claim_policy.sql"), "utf8");

  it("adds claim_policy defaulting existing rows to 'bearer'", () => {
    expect(sql).toMatch(/add column if not exists claim_policy text not null default 'bearer'/);
    expect(sql).toMatch(/check \(claim_policy in \('bearer', 'recipient'\)\)/);
  });

  it("claim_gift returns recipient_mismatch for recipient-bound gifts and keeps prior validations", () => {
    expect(sql).toContain("'recipient_mismatch'");
    expect(sql).toContain("g.claim_policy = 'recipient'");
    expect(sql).toContain("lower(email)"); // profiles.email lookup
    for (const prior of ["invalid_token", "'unavailable'", "'expired'", "'no_value'"]) {
      expect(sql).toContain(prior);
    }
  });
});

/* ── Policy selection at fulfillment ───────────────────────────────────────── */
describe("claim_policy at fulfillment", () => {
  it("webhook stamps claim_policy='recipient' when minting a token for a recipient gift", async () => {
    const gift = pendingGift();
    const db = makeDb({ gift_credits: [gift] });
    service.mockReturnValue(db);
    await handleMonetizationEvent(db as never, giftEvent("gift-1") as never);
    expect(gift.claim_policy).toBe("recipient");
    expect(gift.claim_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gifts without recipient_email keep bearer (no claim token minted)", async () => {
    const gift = pendingGift({ recipient_email: null, claim_policy: "bearer" });
    const db = makeDb({ gift_credits: [gift] });
    service.mockReturnValue(db);
    await handleMonetizationEvent(db as never, giftEvent("gift-1") as never);
    expect(gift.status).toBe("paid");
    expect(gift.claim_token_hash).toBeNull();
    expect(gift.claim_policy).toBe("bearer");
    expect(giftClaimLink).not.toHaveBeenCalled();
  });
});

/* ── Claim API recipient_mismatch mapping ──────────────────────────────────── */
describe("POST /api/gifts/claim recipient policy", () => {
  it("maps recipient_mismatch → 403 with an honest message", async () => {
    const token = "real-token-value-123";
    service.mockReturnValue(makeDb({ gift_credits: [claimableGift(token)] }));
    rpc.mockResolvedValueOnce({ data: { ok: false, error: "recipient_mismatch" }, error: null });
    const res = await claimPOST(claimReq(token));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toBe("This gift was sent to a different email address.");
  });

  it("bearer claims still succeed through the same RPC signature", async () => {
    const token = "real-token-value-123";
    service.mockReturnValue(makeDb({ gift_credits: [claimableGift(token, { claim_policy: "bearer" })] }));
    const res = await claimPOST(claimReq(token));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("claim_gift", { p_token_hash: hashClaimToken(token), p_profile: "user-1" });
  });
});

/* ── Launch gate ───────────────────────────────────────────────────────────── */
describe("giftLaunchStatus", () => {
  it("seeded checklist covers legal/payments/operations honestly", () => {
    const cats = new Set(GIFT_LAUNCH_CHECKLIST.map((i) => i.category));
    expect(cats).toEqual(new Set(["legal", "payments", "operations"]));
    // Nothing is fabricated: code-backed items are 'ready', review items 'pending'.
    for (const i of GIFT_LAUNCH_CHECKLIST) {
      if (i.category === "legal") expect(i.status).toBe("pending");
    }
    expect(GIFT_LAUNCH_CHECKLIST.find((i) => i.key === "fraud_controls")?.status).toBe("ready");
  });

  it("reports awaiting_legal while legal items are pending, regardless of payments", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const s = giftLaunchStatus();
    expect(s.legalApproved).toBe(false);
    expect(s.paymentsConfigured).toBe(true);
    expect(s.technicalReady).toBe(true);
    expect(s.status).toBe("awaiting_legal");
  });

  it("never reports enabled while the sales flag is off", () => {
    vi.stubEnv("GIFT_SALES_ENABLED", "1");
    const s = giftLaunchStatus();
    expect(s.status).not.toBe("enabled"); // legal still pending
  });
});

/* ── ?next= propagation helpers ────────────────────────────────────────────── */
describe("auth-next helpers", () => {
  it("safeNext accepts same-origin paths and rejects everything else", () => {
    expect(safeNext("/account/gifts/claim?t=abc")).toBe("/account/gifts/claim?t=abc");
    for (const bad of ["//evil.com", "https://evil.com", "/api/auth/callback", "\\\\evil", "/a\u0007b", "", null, undefined, `/${"x".repeat(600)}`]) {
      expect(safeNext(bad)).toBeNull();
    }
  });

  it("withNextParam embeds only sanitized next into a redirect URL", () => {
    const good = withNextParam("https://customer.zapnivo.com/api/auth/callback", "/account/gifts/claim?t=tok");
    expect(new URL(good).searchParams.get("next")).toBe("/account/gifts/claim?t=tok");
    for (const bad of ["//evil.com", "https://evil.com/x", "/api/x"]) {
      expect(withNextParam("https://h.example/cb", bad)).toBe("https://h.example/cb");
    }
    expect(withNextParam("https://h.example/cb", null)).toBe("https://h.example/cb");
  });

  it("postAuthDestination prefers sanitized next, falls back to role home", () => {
    expect(postAuthDestination("/account/gifts/claim?t=t", "customer")).toBe("/account/gifts/claim?t=t");
    expect(postAuthDestination("//evil.com", "customer")).toBe("/account");
    expect(postAuthDestination(null, "admin")).toBe("/admin");
    expect(postAuthDestination(null, null)).toBe("/");
  });
});

/* ── Route-level propagation ───────────────────────────────────────────────── */
const localReq = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: { host: "localhost:3000" }, ...init });

describe("auth routes carry next", () => {
  it("GET /api/auth/google puts sanitized next on the OAuth redirectTo", async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/o/oauth2" }, error: null });
    const { GET } = await import("../src/app/api/auth/google/route");
    const res = await GET(localReq("/api/auth/google?next=" + encodeURIComponent("/account/gifts/claim?t=tok")));
    expect(res.status).toBe(307);
    const redirectTo = signInWithOAuth.mock.calls[0][0].options.redirectTo as string;
    expect(new URL(redirectTo).searchParams.get("next")).toBe("/account/gifts/claim?t=tok");
    expect(redirectTo).toContain("/api/auth/callback");
  });

  it("GET /api/auth/google drops unsafe next", async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/o/oauth2" }, error: null });
    const { GET } = await import("../src/app/api/auth/google/route");
    await GET(localReq("/api/auth/google?next=" + encodeURIComponent("https://evil.com")));
    const redirectTo = signInWithOAuth.mock.calls[0][0].options.redirectTo as string;
    expect(new URL(redirectTo).searchParams.get("next")).toBeNull();
  });

  it("POST /api/auth/email-link puts sanitized next on emailRedirectTo", async () => {
    signInWithOtp.mockResolvedValue({ data: {}, error: null });
    const { POST } = await import("../src/app/api/auth/email-link/route");
    const res = await POST(localReq("/api/auth/email-link", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email: "a@b.com", next: "/account/gifts/claim?t=tok" }),
    }));
    expect(res.status).toBe(200);
    const opts = signInWithOtp.mock.calls[0][0].options;
    expect(new URL(opts.emailRedirectTo).searchParams.get("next")).toBe("/account/gifts/claim?t=tok");
  });

  it("POST /api/auth/phone verify passes next to generateLink redirectTo (bound profile path)", async () => {
    const phone = "+12125550123";
    const codeHash = createHash("sha256").update(`654321.dev`).digest("hex"); // secret() dev fallback "dev"
    const db = makeDb({
      phone_otps: [{ id: 1, phone, code_hash: codeHash, attempts: 0, used: false, expires_at: new Date(Date.now() + 600_000).toISOString() }],
      profiles: [{ id: "p1", email: "bound@example.com", phone }],
    });
    generateLink.mockResolvedValue({ data: { properties: { action_link: "https://x/verify" } }, error: null });
    service.mockReturnValue(Object.assign(db, {
      auth: { admin: { generateLink: (arg: unknown) => generateLink(arg) } },
    }));
    const { POST } = await import("../src/app/api/auth/phone/route");
    const res = await POST(localReq("/api/auth/phone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "verify", phone, code: "654321", next: "/account/gifts/claim?t=tok" }),
    }));
    expect(res.status).toBe(200);
    const redirectTo = generateLink.mock.calls[0][0].options.redirectTo as string;
    expect(new URL(redirectTo).searchParams.get("next")).toBe("/account/gifts/claim?t=tok");
    expect(redirectTo).toContain("/api/auth/callback");
  });

  it("GET /api/auth/callback redirects to sanitized next over the role home", async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: "tok", expires_in: 3600 }, user: { id: "u1", email: "c@x.com" } },
      error: null,
    });
    const db = makeDb({
      profiles: [{ id: "u1", role: "customer", organization_id: null }],
      phone_claims: [],
    });
    service.mockReturnValue(db);
    const { GET } = await import("../src/app/api/auth/callback/route");
    const res = await GET(localReq("/api/auth/callback?code=abc&next=" + encodeURIComponent("/account/gifts/claim?t=tok")));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/account/gifts/claim?t=tok");
  });

  it("GET /api/auth/callback falls back to role home for missing/unsafe next", async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: "tok", expires_in: 3600 }, user: { id: "u1", email: "c@x.com" } },
      error: null,
    });
    service.mockReturnValue(makeDb({ profiles: [{ id: "u1", role: "admin", organization_id: null }], phone_claims: [] }));
    const { GET } = await import("../src/app/api/auth/callback/route");
    const res = await GET(localReq("/api/auth/callback?code=abc&next=" + encodeURIComponent("https://evil.com")));
    expect(res.headers.get("location")).toBe("http://localhost:3000/admin");
  });
});
