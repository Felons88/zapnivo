import type { SupabaseClient } from "@supabase/supabase-js";
import { grantElevation, ELEVATION_TTL_MS } from "./elevation";
import { systemAudit } from "./audit";

/**
 * Supabase Auth MFA (TOTP) for the system plane.
 *
 * All factor secrets live in Supabase auth.mfa_factors — NEVER in app tables.
 * This module talks to GoTrue directly over HTTPS using the CALLER's access
 * token (the zapnivo_access session cookie value), so every enroll/challenge/
 * verify/unenroll acts as the signed-in user and is bound to their session.
 *
 * SECURITY RULES enforced here:
 *  - enroll/challenge/verify responses are returned to the client ONCE; the
 *    TOTP secret and otpauth URI are never written to any table or audit row.
 *  - verify success grants a 15-minute system_elevations row (method='totp')
 *    — it does NOT touch auth_sessions and cannot extend the 24h session.
 *  - audit detail is scrubbed by systemAudit; we additionally never pass
 *    secret/code/uri fields into detail.
 */

export type MfaConfig = { url: string; anonKey: string };

/** Reads the public Supabase config needed for GoTrue calls. Null when unset. */
export function mfaConfig(): MfaConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/+$/, ""), anonKey };
}

export type GotrueError = { message: string; status: number; code?: string };
export type GotrueResult<T> = { ok: true; data: T } | { ok: false; error: GotrueError };

async function gotrue<T>(
  config: MfaConfig,
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<GotrueResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.url}/auth/v1${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : "network error", status: 0 } };
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const j = json as { msg?: string; message?: string; error_code?: string; code?: string } | null;
    return {
      ok: false,
      error: {
        message: j?.msg ?? j?.message ?? `GoTrue HTTP ${res.status}`,
        status: res.status,
        code: j?.error_code ?? j?.code,
      },
    };
  }
  return { ok: true, data: json as T };
}

/* ── Types mirroring supabase-js auth.mfa shapes ─────────────────────────── */

export type TotpFactor = {
  id: string;
  friendly_name?: string | null;
  factor_type?: string;
  status?: string; // 'unverified' | 'verified'
  created_at?: string;
  updated_at?: string;
};

export type EnrollTotpResult = {
  factorId: string;
  /** Base32 secret — shown ONCE for manual entry, never persisted. */
  secret: string;
  /** otpauth:// URI — render as QR, never persisted. */
  uri: string;
  /** SVG QR markup returned by GoTrue (may be empty on older versions). */
  qrSvg: string | null;
};

type EnrollResponse = {
  id?: string;
  type?: string;
  totp?: { qr_code?: string; secret?: string; uri?: string };
};
type ChallengeResponse = { id?: string; expires_at?: string };
type FactorsResponse = {
  all?: unknown[];
  totp?: unknown[];
  phone?: unknown[];
} | unknown[];

const normFactor = (v: unknown): TotpFactor | null => {
  const f = v as Record<string, unknown> | null;
  if (!f || typeof f.id !== "string") return null;
  return {
    id: f.id,
    friendly_name: typeof f.friendly_name === "string" ? f.friendly_name : null,
    factor_type: typeof f.factor_type === "string" ? f.factor_type : typeof f.type === "string" ? (f.type as string) : undefined,
    status: typeof f.status === "string" ? f.status : undefined,
    created_at: typeof f.created_at === "string" ? f.created_at : undefined,
    updated_at: typeof f.updated_at === "string" ? f.updated_at : undefined,
  };
};

/** POST /auth/v1/factors — start TOTP enrollment. Returns secret+URI ONCE. */
export async function enrollTotp(
  accessToken: string,
  opts: { config?: MfaConfig | null; fetchImpl?: typeof fetch; friendlyName?: string } = {},
): Promise<GotrueResult<EnrollTotpResult>> {
  const config = opts.config === undefined ? mfaConfig() : opts.config;
  if (!config) return { ok: false, error: { message: "Supabase Auth not configured", status: 503 } };
  if (!accessToken) return { ok: false, error: { message: "No session token", status: 401 } };
  const res = await gotrue<EnrollResponse>(config, accessToken, "/factors", {
    body: { factor_type: "totp", friendly_name: opts.friendlyName?.slice(0, 120) || "system-console" },
  }, opts.fetchImpl);
  if (!res.ok) return res;
  const d = res.data;
  const factorId = d?.id;
  const totp = d?.totp;
  if (!factorId || !totp?.secret || !totp?.uri) {
    return { ok: false, error: { message: "Unexpected enroll response", status: 502 } };
  }
  return {
    ok: true,
    data: {
      factorId,
      secret: totp.secret,
      uri: totp.uri,
      qrSvg: typeof totp.qr_code === "string" && totp.qr_code.length > 0 ? totp.qr_code : null,
    },
  };
}

/** POST /auth/v1/factors/{id}/challenge — returns a challenge id + expiry. */
export async function challengeTotp(
  accessToken: string,
  factorId: string,
  opts: { config?: MfaConfig | null; fetchImpl?: typeof fetch } = {},
): Promise<GotrueResult<{ challengeId: string; expiresAt: string | null }>> {
  const config = opts.config === undefined ? mfaConfig() : opts.config;
  if (!config) return { ok: false, error: { message: "Supabase Auth not configured", status: 503 } };
  if (!accessToken) return { ok: false, error: { message: "No session token", status: 401 } };
  if (!factorId) return { ok: false, error: { message: "factor_id required", status: 400 } };
  const res = await gotrue<ChallengeResponse>(config, accessToken, `/factors/${encodeURIComponent(factorId)}/challenge`, { method: "POST", body: {} }, opts.fetchImpl);
  if (!res.ok) return res;
  if (!res.data?.id) return { ok: false, error: { message: "Unexpected challenge response", status: 502 } };
  return { ok: true, data: { challengeId: res.data.id, expiresAt: res.data.expires_at ?? null } };
}

/** GET /auth/v1/factors — all factors for the caller's user. */
export async function listFactors(
  accessToken: string,
  opts: { config?: MfaConfig | null; fetchImpl?: typeof fetch } = {},
): Promise<GotrueResult<{ all: TotpFactor[]; totp: TotpFactor[] }>> {
  const config = opts.config === undefined ? mfaConfig() : opts.config;
  if (!config) return { ok: false, error: { message: "Supabase Auth not configured", status: 503 } };
  if (!accessToken) return { ok: false, error: { message: "No session token", status: 401 } };
  const res = await gotrue<FactorsResponse>(config, accessToken, "/factors", {}, opts.fetchImpl);
  if (!res.ok) return res;
  const d = res.data;
  const pick = (v: unknown): TotpFactor[] =>
    (Array.isArray(v) ? v : []).map(normFactor).filter((f): f is TotpFactor => f !== null);
  if (Array.isArray(d)) return { ok: true, data: { all: pick(d), totp: pick(d) } };
  const obj = (d ?? {}) as { all?: unknown[]; totp?: unknown[] };
  return { ok: true, data: { all: pick(obj.all), totp: pick(obj.totp) } };
}

/** True when the caller has at least one VERIFIED TOTP factor. */
export async function hasVerifiedTotp(
  accessToken: string,
  opts: { config?: MfaConfig | null; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true; verified: boolean } | { ok: false; error: GotrueError }> {
  const res = await listFactors(accessToken, opts);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, verified: res.data.totp.some((f) => f.status === "verified") };
}

/** DELETE /auth/v1/factors/{id} — unenroll a factor (caller must be elevated). */
export async function unenrollFactor(
  accessToken: string,
  factorId: string,
  opts: { config?: MfaConfig | null; fetchImpl?: typeof fetch } = {},
): Promise<GotrueResult<null>> {
  const config = opts.config === undefined ? mfaConfig() : opts.config;
  if (!config) return { ok: false, error: { message: "Supabase Auth not configured", status: 503 } };
  if (!accessToken) return { ok: false, error: { message: "No session token", status: 401 } };
  if (!factorId) return { ok: false, error: { message: "factor_id required", status: 400 } };
  const res = await gotrue<unknown>(config, accessToken, `/factors/${encodeURIComponent(factorId)}`, { method: "DELETE" }, opts.fetchImpl);
  if (!res.ok) return res;
  return { ok: true, data: null };
}

export type VerifyTotpInput = { factorId: string; challengeId: string; code: string };
export type VerifyTotpResult =
  | { ok: true; elevatedUntil: string | null; elevationId: string | null }
  | { ok: false; status: number; error: string };

/**
 * POST /auth/v1/factors/{id}/verify — on success grants a 15-minute elevation
 * (method='totp') and audits mfa.totp.verified. The submitted code and any
 * secrets are never stored or logged. `deps` allow tests to inject config +
 * fetch and a fake db.
 */
export async function verifyTotp(
  db: SupabaseClient | null | undefined,
  user: { id: string; email?: string },
  accessToken: string,
  input: VerifyTotpInput,
  deps: { config?: MfaConfig | null; fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<VerifyTotpResult> {
  const config = deps.config === undefined ? mfaConfig() : deps.config;
  if (!config) return { ok: false, status: 503, error: "Supabase Auth not configured" };
  const code = input.code.replace(/\s+/g, "");
  if (!input.factorId || !input.challengeId || !/^\d{6,8}$/.test(code)) {
    return { ok: false, status: 400, error: "factor_id, challenge_id and a 6-8 digit code are required" };
  }
  const res = await gotrue<unknown>(
    config,
    accessToken,
    `/factors/${encodeURIComponent(input.factorId)}/verify`,
    { body: { challenge_id: input.challengeId, code } },
    deps.fetchImpl,
  );
  if (!res.ok) {
    return { ok: false, status: res.error.status >= 400 && res.error.status < 600 ? res.error.status : 502, error: res.error.message };
  }
  // Success — elevate for the action window and audit (never the code/secret).
  const grant = await grantElevation(db, user.id, "totp", { nowMs: deps.nowMs });
  await systemAudit(db, {
    actor: { id: user.id, role: "system" },
    action: "mfa.totp.verified",
    resource: `profile:${user.id}`,
    detail: { factor_id: input.factorId, elevated: grant.ok },
  });
  return {
    ok: true,
    elevatedUntil: grant.ok ? grant.expiresAt : null,
    elevationId: grant.ok ? grant.id : null,
  };
}

export { ELEVATION_TTL_MS };
