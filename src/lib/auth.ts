import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { anonClient, serviceClient } from "./supabase";
import { devAuth, DEV_COOKIE, DEV_USERS, type SessionUser } from "./dev-auth";

export type Role = "admin" | "staff" | "partner" | "customer";
// Re-exported from ./dev-auth (edge-safe) so edge-bundled modules can use them
// without pulling this file's node:crypto imports into the edge bundle.
export type { SessionUser } from "./dev-auth";
export { devAuth, DEV_USERS, DEV_COOKIE } from "./dev-auth";

export const SESSION_COOKIE = "zapnivo_access";
/** Signed first-authentication anchor — fallback deadline for tokens without a session_id claim. */
export const ANCHOR_COOKIE = "zapnivo_anchor";

export const authConfigured = () => devAuth() || Boolean(anonClient() && serviceClient());

/** Absolute session ceiling: original authentication + 24h. Refresh never extends it. */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Decodes an already-signature-verified JWT payload segment helpers. */
const jwtPayload = (token: string): Record<string, unknown> | null => {
  try {
    const p = token.split(".")[1];
    return p ? (JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>) : null;
  } catch { return null; }
};

/** Supabase access tokens carry a stable `session_id` claim — the registry key. */
export const jwtSessionId = (token: string): string | null => {
  const sid = jwtPayload(token)?.session_id;
  return typeof sid === "string" && sid.length > 0 && sid.length <= 120 ? sid : null;
};

export const jwtIssuedAt = (token: string): number | null => {
  const iat = jwtPayload(token)?.iat;
  return typeof iat === "number" && Number.isFinite(iat) ? iat * 1000 : null;
};

/* ── Anchor cookie (fallback for tokens lacking session_id) ────────────────── */

const anchorSecret = () => {
  const s = process.env.AUTH_ANCHOR_SECRET ?? process.env.HELPDESK_SECRET;
  if (!s && process.env.NODE_ENV === "production") return null;
  return s ?? "dev";
};

/** Builds the signed anchor value: base64url(json{u,t}) + "." + hmac. Set at login/callback. */
export function makeAnchorCookie(userId: string, authAtMs: number): string | null {
  const sec = anchorSecret();
  if (!sec) return null;
  const body = Buffer.from(JSON.stringify({ u: userId, t: authAtMs })).toString("base64url");
  const sig = createHmac("sha256", sec).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Verifies an anchor cookie; returns {userId, authAtMs} or null. */
export function verifyAnchorCookie(value: string | undefined): { userId: string; authAtMs: number } | null {
  const sec = anchorSecret();
  if (!sec || !value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const body = value.slice(0, dot), sig = value.slice(dot + 1);
  const want = createHmac("sha256", sec).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const j = JSON.parse(Buffer.from(body, "base64url").toString()) as { u?: string; t?: number };
    if (typeof j.u !== "string" || typeof j.t !== "number" || !Number.isFinite(j.t)) return null;
    return { userId: j.u, authAtMs: j.t };
  } catch { return null; }
}

/* ── Session registry enforcement ──────────────────────────────────────────── */

type SessionRow = { session_key: string; user_id: string; created_at: string; expires_at: string; revoked_at: string | null; last_seen_at: string };

/**
 * Enforces the absolute deadline for a registry-backed session.
 * First-seen inserts anchor created_at=now (≈ real auth time for fresh logins).
 * Returns the row when valid, null when expired/revoked/foreign.
 */
async function enforceSession(
  db: NonNullable<ReturnType<typeof serviceClient>>,
  key: string, userId: string, authMethod: string | null, nowMs: number,
  onFirstSeen?: (() => void) | null,
): Promise<SessionRow | null> {
  const { data } = await db.from("auth_sessions")
    .select("session_key,user_id,created_at,expires_at,revoked_at,last_seen_at")
    .eq("session_key", key).maybeSingle();
  const row = data as SessionRow | null;
  if (row) {
    if (row.user_id !== userId || row.revoked_at) return null;
    if (Date.parse(row.expires_at) <= nowMs) return null;
    // Throttled last-seen touch (at most once per 5 min).
    if (nowMs - Date.parse(row.last_seen_at) > 5 * 60_000) {
      void db.from("auth_sessions").update({ last_seen_at: new Date(nowMs).toISOString() }).eq("session_key", key).then(() => undefined, () => undefined);
    }
    return row;
  }
  const created = new Date(nowMs).toISOString();
  const expires = new Date(nowMs + SESSION_MAX_AGE_MS).toISOString();
  const { data: ins, error } = await db.from("auth_sessions")
    .insert({ session_key: key, user_id: userId, auth_method: authMethod, created_at: created, last_seen_at: created, expires_at: expires })
    .select("session_key,user_id,created_at,expires_at,revoked_at,last_seen_at").single();
  if (error || !ins) return null; // registry unavailable → fail closed for protected routes
  if (onFirstSeen) { try { onFirstSeen(); } catch { /* security alert must never break auth */ } }
  return ins as SessionRow;
}

/** Approximate location from edge geo headers — label "near Chicago, US" plus
 *  coarse lat/lng for the app's security map. Never presented as exact. */
function geoHint(h: Headers | null): { label: string; lat: string; lng: string } {
  if (!h) return { label: "", lat: "", lng: "" };
  try {
    const city = h.get("x-vercel-ip-city"), country = h.get("x-vercel-ip-country");
    const where = [city ? decodeURIComponent(city) : null, country].filter(Boolean).join(", ");
    return {
      label: where ? ` near ${where}` : "",
      lat: h.get("x-vercel-ip-latitude") ?? "",
      lng: h.get("x-vercel-ip-longitude") ?? "",
    };
  } catch { return { label: "", lat: "", lng: "" }; }
}

/** Emits the new-device sign-in alert for a first-seen session. Best-effort.
 *  Geo/deep-link fields ride as _-prefixed vars — copied into notification
 *  data by the engine, never rendered into customer copy. */
export function alertNewSignIn(
  db: NonNullable<ReturnType<typeof serviceClient>>,
  userId: string, sessionKey: string, device: string, h: Headers | null,
): void {
  const geo = geoHint(h);
  void import("./notify").then(({ emit }) => emit(db, {
    profileId: userId, kind: "new_signin",
    vars: { device, location: geo.label, _lat: geo.lat, _lng: geo.lng, _place: geo.label.replace(/^ near /, ""), _device: device },
    deepLink: "security",
    dedupeKey: `signin:${sessionKey}`,
  })).catch(() => undefined);
}

/** Session context for AI tools / audit: which registry row backs this request. */
export type SessionContext = { sessionKey: string | null; expiresAt: string | null };

/**
 * Verifies the access token with Supabase and loads the role server-side.
 * Enforces the absolute 24h deadline via the auth_sessions registry (session_id
 * claim) or the signed anchor cookie fallback. Returns null when unauthenticated
 * or expired. `nowMs` is injectable for deterministic tests.
 */
export async function getSessionUser(nowMs = Date.now()): Promise<SessionUser | null> {
  if (devAuth()) {
    const as = (await cookies()).get(DEV_COOKIE)?.value as keyof typeof DEV_USERS | undefined;
    return { ...DEV_USERS[as && as in DEV_USERS ? as : "admin"] };
  }
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const anon = anonClient();
  const svc = serviceClient();
  if (!token || !anon || !svc) return null;

  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) return null;
  const userId = data.user.id;

  // 1) Registry path — Supabase session_id claim is refresh-stable.
  const sid = jwtSessionId(token);
  if (sid) {
    const hdrs = await Promise.resolve().then(() => headers()).catch(() => null) as Headers | null;
    const row = await enforceSession(svc, `sso:${sid}`, userId, "supabase", nowMs, () => alertNewSignIn(svc, userId, `sso:${sid}`, "browser", hdrs)).catch(() => null);
    if (!row) return null;
    const { data: profile } = await svc.from("profiles").select("role, organization_id").eq("id", userId).single();
    if (!profile) return null;
    return { id: userId, email: data.user.email ?? "", role: profile.role as Role, organizationId: profile.organization_id };
  }

  // 2) Anchor fallback — signed cookie records first-seen auth time; refresh can't move it.
  const anchor = verifyAnchorCookie(jar.get(ANCHOR_COOKIE)?.value);
  if (!anchor || anchor.userId !== userId) return null;
  if (anchor.authAtMs + SESSION_MAX_AGE_MS <= nowMs) return null;
  // Belt-and-braces: also reject JWTs older than the ceiling even if anchor is fresh.
  const iat = jwtIssuedAt(token);
  if (iat === null || iat + SESSION_MAX_AGE_MS <= nowMs) return null;

  const { data: profile } = await svc.from("profiles").select("role, organization_id").eq("id", userId).single();
  if (!profile) return null;
  return { id: userId, email: data.user.email ?? "", role: profile.role as Role, organizationId: profile.organization_id };
}

/** Native clients use a Supabase bearer token instead of the website's HTTP-only cookie. */
export async function getBearerUser(req: Request, nowMs = Date.now()): Promise<SessionUser | null> {
  const authorization = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  if (!match) return null;
  const anon = anonClient();
  const svc = serviceClient();
  if (!anon || !svc) return null;
  const { data, error } = await anon.auth.getUser(match[1]);
  if (error || !data.user) return null;
  const sid = jwtSessionId(match[1]);
  if (!sid) return null;
  const active = await enforceSession(svc, `sso:${sid}`, data.user.id, "mobile", nowMs, () => alertNewSignIn(svc, data.user.id, `sso:${sid}`, "mobile app", req.headers)).catch(() => null);
  if (!active) return null;
  const { data: profile } = await svc.from("profiles")
    .select("role,organization_id,email").eq("id", data.user.id).maybeSingle();
  if (!profile) return null;
  return { id: data.user.id, email: profile.email, role: profile.role as Role, organizationId: profile.organization_id };
}

/** Revokes the registry session backing the current cookie (logout). Best-effort. */
export async function revokeCurrentSession(): Promise<void> {
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    const svc = serviceClient();
    const sid = token ? jwtSessionId(token) : null;
    if (!svc || !sid) return;
    await svc.from("auth_sessions").update({ revoked_at: new Date().toISOString() }).eq("session_key", `sso:${sid}`).is("revoked_at", null);
  } catch { /* revocation is best-effort; cookie deletion still applies */ }
}

export const isStaff = (u: SessionUser | null) => u?.role === "admin" || u?.role === "staff";
