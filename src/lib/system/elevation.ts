import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import { systemAudit } from "./audit";

/**
 * Step-up elevation (migration 0043, table system_elevations).
 *
 * An elevation is a SHORT-LIVED grant (default 15 min) that authorizes one
 * window of high-risk mutations after a fresh factor check (TOTP verify today,
 * password re-auth possible later). It is completely independent of the
 * session: it never touches auth_sessions, never extends the 24h absolute
 * session cap, and carries no credential material — only profile_id, method,
 * and timestamps. Rows are written via the service role; RLS is select-only.
 */

export const ELEVATION_TTL_MS = 15 * 60_000;
export const ELEVATION_DEFAULT_MAX_AGE_MINUTES = 15;

export type ElevationMethod = "totp" | "password";
export const ELEVATION_METHODS: readonly ElevationMethod[] = ["totp", "password"];

export type ElevationRow = {
  id: string;
  profile_id: string;
  method: ElevationMethod;
  created_at: string;
  expires_at: string;
  consumed_action: string | null;
  created_ip: string | null;
};

const asRow = (v: unknown): ElevationRow | null => {
  const r = v as Partial<ElevationRow> | null;
  if (!r || typeof r.id !== "string" || typeof r.profile_id !== "string") return null;
  return {
    id: r.id,
    profile_id: r.profile_id,
    method: r.method === "password" ? "password" : "totp",
    created_at: typeof r.created_at === "string" ? r.created_at : "",
    expires_at: typeof r.expires_at === "string" ? r.expires_at : "",
    consumed_action: typeof r.consumed_action === "string" ? r.consumed_action : null,
    created_ip: typeof r.created_ip === "string" ? r.created_ip : null,
  };
};

/**
 * Issues a new elevation for `profileId`. `nowMs` is injectable for tests.
 * Returns the row id + expiry, or an error. Audited as elevation.granted.
 */
export async function grantElevation(
  db: SupabaseClient | null | undefined,
  profileId: string,
  method: ElevationMethod,
  opts: { ip?: string | null; nowMs?: number } = {},
): Promise<{ ok: true; id: string; expiresAt: string } | { ok: false; error: string }> {
  if (!db) return { ok: false, error: "Backend not configured" };
  const nowMs = opts.nowMs ?? Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ELEVATION_TTL_MS).toISOString();
  const { data, error } = await db
    .from("system_elevations")
    .insert({
      profile_id: profileId,
      method,
      created_at: createdAt,
      expires_at: expiresAt,
      created_ip: opts.ip ?? null,
    })
    .select("id,expires_at")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "elevation insert failed" };
  const row = data as { id: string; expires_at: string };
  await systemAudit(db, {
    actor: { id: profileId, role: "system" },
    action: "elevation.granted",
    resource: `profile:${profileId}`,
    detail: { method, expires_at: row.expires_at ?? expiresAt },
  });
  return { ok: true, id: row.id, expiresAt: row.expires_at ?? expiresAt };
}

/**
 * Returns the newest still-valid elevation row for a profile, or null.
 * Valid = not expired AND created within `maxAgeMinutes` (default 15).
 * `nowMs` injectable for deterministic tests; filtering is done in JS so the
 * check is honest even if the DB clock and app clock drift.
 */
export async function activeElevation(
  db: SupabaseClient | null | undefined,
  profileId: string,
  maxAgeMinutes = ELEVATION_DEFAULT_MAX_AGE_MINUTES,
  nowMs = Date.now(),
): Promise<ElevationRow | null> {
  if (!db || !profileId) return null;
  try {
    const { data, error } = await db
      .from("system_elevations")
      .select("id,profile_id,method,created_at,expires_at,consumed_action,created_ip")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error || !Array.isArray(data)) return null;
    const maxAgeMs = Math.max(1, maxAgeMinutes) * 60_000;
    for (const raw of data) {
      const row = asRow(raw);
      if (!row) continue;
      const created = Date.parse(row.created_at);
      const expires = Date.parse(row.expires_at);
      if (!Number.isFinite(created) || !Number.isFinite(expires)) continue;
      if (expires <= nowMs) continue;
      if (nowMs - created > maxAgeMs) continue;
      return row;
    }
    return null;
  } catch {
    return null;
  }
}

/** Boolean convenience wrapper around activeElevation. */
export async function hasElevation(
  db: SupabaseClient | null | undefined,
  profileId: string,
  maxAgeMinutes = ELEVATION_DEFAULT_MAX_AGE_MINUTES,
  nowMs = Date.now(),
): Promise<boolean> {
  return (await activeElevation(db, profileId, maxAgeMinutes, nowMs)) !== null;
}

export type ElevationCheck =
  | { ok: true; method: ElevationMethod; expiresAt: string; elevationId: string }
  | { ok: false; status: 401 | 403; error: string; code?: "step_up_required" };

/**
 * Gate for high-risk mutations. Returns ok only when the user holds a live
 * elevation; otherwise a 403 with code 'step_up_required' so clients can show
 * "verify MFA / re-authenticate first". `nowMs` injectable for tests.
 */
export async function requireElevation(
  db: SupabaseClient | null | undefined,
  user: SessionUser | null,
  maxAgeMinutes = ELEVATION_DEFAULT_MAX_AGE_MINUTES,
  nowMs = Date.now(),
): Promise<ElevationCheck> {
  if (!user) return { ok: false, status: 401, error: "Unauthenticated" };
  if (!db) return { ok: false, status: 403, error: "Backend not configured", code: "step_up_required" };
  const row = await activeElevation(db, user.id, maxAgeMinutes, nowMs);
  if (!row) {
    return {
      ok: false,
      status: 403,
      error: "Step-up verification required — confirm with MFA (or re-authenticate) before this action.",
      code: "step_up_required",
    };
  }
  return { ok: true, method: row.method, expiresAt: row.expires_at, elevationId: row.id };
}
