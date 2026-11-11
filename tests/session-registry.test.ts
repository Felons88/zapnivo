import { beforeEach, describe, expect, it, vi } from "vitest";

const { jar, dbHolder, authUser } = vi.hoisted(() => ({
  jar: { cookies: new Map<string, string>() },
  dbHolder: { db: null as unknown },
  authUser: { user: null as null | { id: string; email: string } },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (jar.cookies.has(n) ? { value: jar.cookies.get(n)! } : undefined) }),
}));
vi.mock("@/lib/supabase", () => ({
  anonClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser.user }, error: authUser.user ? null : new Error("bad") }) } }),
  serviceClient: () => dbHolder.db,
}));

import { ANCHOR_COOKIE, getSessionUser, jwtSessionId, makeAnchorCookie, SESSION_COOKIE, SESSION_MAX_AGE_MS, verifyAnchorCookie } from "@/lib/auth";

const UID = "11111111-1111-4111-8111-111111111111";
const jwt = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

// ── Minimal auth_sessions fake ──────────────────────────────────────────────
type Row = Record<string, any>;
function fakeDb() {
  const rows = new Map<string, Row>();
  const profile = { role: "customer", organization_id: null };
  const db = {
    from(table: string) {
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: profile }) }) }) };
      }
      // auth_sessions
      const filters: [string, string, unknown][] = [];
      const api = {
        select: () => api,
        eq: (f: string, v: unknown) => { filters.push(["eq", f, v]); return api; },
        is: () => api,
        lt: () => api,
        maybeSingle: async () => {
          const key = filters.find((f) => f[1] === "session_key")?.[2] as string;
          const r = rows.get(key);
          return { data: r ? { ...r } : null, error: null };
        },
        single: async () => ({ data: null, error: null }),
        insert: (row: Row) => {
          rows.set(row.session_key, { ...row });
          return { select: () => ({ single: async () => ({ data: { ...rows.get(row.session_key)! }, error: null }) }) };
        },
        update: (patch: Row) => ({ eq: async () => ({ error: null }), then: (f: any) => Promise.resolve({ error: null }).then(f) }),
      };
      return api;
    },
  };
  return { db, rows };
}

beforeEach(() => {
  jar.cookies.clear();
  authUser.user = { id: UID, email: "a@x.com" };
});

describe("jwtSessionId", () => {
  it("extracts the stable session_id claim", () => {
    expect(jwtSessionId(jwt({ session_id: "sess-1" }))).toBe("sess-1");
    expect(jwtSessionId(jwt({ iat: 1 }))).toBeNull();
    expect(jwtSessionId("bad")).toBeNull();
  });
});

describe("anchor cookie", () => {
  it("round-trips and rejects tampering", () => {
    const v = makeAnchorCookie(UID, 1000)!;
    expect(verifyAnchorCookie(v)).toEqual({ userId: UID, authAtMs: 1000 });
    expect(verifyAnchorCookie(v.slice(0, -2) + "xx")).toBeNull();
    expect(verifyAnchorCookie(undefined)).toBeNull();
    expect(verifyAnchorCookie("garbage")).toBeNull();
  });
});

describe("getSessionUser — registry path (session_id claim)", () => {
  const NOW = 1_800_000_000_000;
  const tokenWithSid = (sid: string) => jwt({ session_id: sid, iat: Math.floor(NOW / 1000) });

  it("first request registers the session anchored at now", async () => {
    const { db, rows } = fakeDb(); dbHolder.db = db;
    jar.cookies.set(SESSION_COOKIE, tokenWithSid("s1"));
    const u = await getSessionUser(NOW);
    expect(u?.id).toBe(UID);
    const row = rows.get("sso:s1")!;
    expect(Date.parse(row.expires_at)).toBe(NOW + SESSION_MAX_AGE_MS);
  });

  it("same session still valid before expiry — refresh does NOT extend", async () => {
    const { db, rows } = fakeDb(); dbHolder.db = db;
    jar.cookies.set(SESSION_COOKIE, tokenWithSid("s1"));
    await getSessionUser(NOW);
    // Simulate a refreshed JWT: new iat, same session_id, request at +20h.
    const later = NOW + 20 * 3600_000;
    jar.cookies.set(SESSION_COOKIE, jwt({ session_id: "s1", iat: Math.floor(later / 1000) }));
    expect((await getSessionUser(later))?.id).toBe(UID);
    // …and past the absolute deadline even though iat is fresh.
    const expired = NOW + SESSION_MAX_AGE_MS + 1000;
    jar.cookies.set(SESSION_COOKIE, jwt({ session_id: "s1", iat: Math.floor(expired / 1000) }));
    expect(await getSessionUser(expired)).toBeNull();
    expect(rows.get("sso:s1")).toBeTruthy();
  });

  it("clock boundary: valid 1ms before expiry, dead exactly at expires_at", async () => {
    const { db } = fakeDb(); dbHolder.db = db;
    jar.cookies.set(SESSION_COOKIE, tokenWithSid("s-boundary"));
    await getSessionUser(NOW); // registers: expires_at = NOW + 24h
    const deadline = NOW + SESSION_MAX_AGE_MS;
    jar.cookies.set(SESSION_COOKIE, jwt({ session_id: "s-boundary", iat: Math.floor((deadline - 1) / 1000) }));
    expect((await getSessionUser(deadline - 1))?.id).toBe(UID);
    jar.cookies.set(SESSION_COOKIE, jwt({ session_id: "s-boundary", iat: Math.floor(deadline / 1000) }));
    expect(await getSessionUser(deadline)).toBeNull();
  });

  it("multiple concurrent sessions for one user are independent", async () => {
    const { db } = fakeDb(); dbHolder.db = db;
    jar.cookies.set(SESSION_COOKIE, tokenWithSid("s-a"));
    expect((await getSessionUser(NOW))?.id).toBe(UID);
    jar.cookies.set(SESSION_COOKIE, tokenWithSid("s-b"));
    expect((await getSessionUser(NOW + 3600_000))?.id).toBe(UID);
    // Revoking s-a must not affect s-b.
    jar.cookies.set(SESSION_COOKIE, tokenWithSid("s-a"));
    await getSessionUser(NOW);
    // s-b still fine afterwards
    jar.cookies.set(SESSION_COOKIE, tokenWithSid("s-b"));
    expect((await getSessionUser(NOW + 3700_000))?.id).toBe(UID);
  });

  it("revoked sessions are rejected", async () => {
    const { db, rows } = fakeDb(); dbHolder.db = db;
    rows.set("sso:s2", { session_key: "sso:s2", user_id: UID, created_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + SESSION_MAX_AGE_MS).toISOString(), revoked_at: new Date(NOW).toISOString(), last_seen_at: new Date(NOW).toISOString() });
    jar.cookies.set(SESSION_COOKIE, tokenWithSid("s2"));
    expect(await getSessionUser(NOW)).toBeNull();
  });

  it("a session registered to another user is rejected", async () => {
    const { db, rows } = fakeDb(); dbHolder.db = db;
    rows.set("sso:s3", { session_key: "sso:s3", user_id: "other", created_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + SESSION_MAX_AGE_MS).toISOString(), revoked_at: null, last_seen_at: new Date(NOW).toISOString() });
    jar.cookies.set(SESSION_COOKIE, tokenWithSid("s3"));
    expect(await getSessionUser(NOW)).toBeNull();
  });
});

describe("getSessionUser — anchor fallback (no session_id claim)", () => {
  const NOW = 1_800_000_000_000;
  const bareJwt = () => jwt({ iat: Math.floor(NOW / 1000) });

  it("valid anchor + fresh iat → authenticated until anchor+24h", async () => {
    const { db } = fakeDb(); dbHolder.db = db;
    jar.cookies.set(SESSION_COOKIE, bareJwt());
    jar.cookies.set(ANCHOR_COOKIE, makeAnchorCookie(UID, NOW)!);
    expect((await getSessionUser(NOW))?.id).toBe(UID);
    // Past the absolute deadline the same anchor is dead even with a fresh iat.
    const expired = NOW + SESSION_MAX_AGE_MS + 1;
    jar.cookies.set(SESSION_COOKIE, jwt({ iat: Math.floor(expired / 1000) }));
    expect(await getSessionUser(expired)).toBeNull();
  });

  it("missing or foreign anchor → rejected", async () => {
    const { db } = fakeDb(); dbHolder.db = db;
    jar.cookies.set(SESSION_COOKIE, bareJwt());
    expect(await getSessionUser(NOW)).toBeNull();
    jar.cookies.set(ANCHOR_COOKIE, makeAnchorCookie("someone-else", NOW)!);
    expect(await getSessionUser(NOW)).toBeNull();
  });

  it("registry-unavailable fails closed", async () => {
    dbHolder.db = { from: () => { throw new Error("down"); } };
    jar.cookies.set(SESSION_COOKIE, jwt({ session_id: "s9", iat: Math.floor(NOW / 1000) }));
    expect(await getSessionUser(NOW)).toBeNull();
  });
});
