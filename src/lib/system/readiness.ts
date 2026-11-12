import type { SupabaseClient } from "@supabase/supabase-js";
import { DEVICE_AUTH_METHODS } from "./device-auth";
import { kekStatus } from "./device-auth";

/**
 * Security readiness aggregate for /system/security/readiness.
 *
 * REAL counts only — every number comes from a live count query. No credential
 * material (enc payloads, hashes, secrets) is ever selected; only booleans,
 * counts, timestamps, and status fields leave this module. Each probe is
 * individually fault-tolerant: a missing table/column reports null, never a
 * fabricated zero.
 */

export type ReadinessCount = number | null;

export type SecurityReadiness = {
  configured: boolean;
  generated_at: string;
  devices: {
    total: ReadinessCount;
    by_auth_method: Record<string, ReadinessCount>;
    /** enc = device_secret_enc set · legacy_hash = hash-only · none = neither. */
    key_mode: { enc: ReadinessCount; legacy_hash: ReadinessCount; none: ReadinessCount };
  };
  credentials: {
    pending_rotations: ReadinessCount;
    expiring_within_30d: ReadinessCount;
    expired: ReadinessCount;
  };
  device_auth_24h: {
    rejected: ReadinessCount;
    duplicate_message_rejections: ReadinessCount;
  };
  /** Unexpired step-up elevations (system_elevations). */
  active_elevations: ReadinessCount;
  /** Privileged bootstrap grants — the 0047 unique index caps this at 1. */
  bootstrap_grants: ReadinessCount;
  retention_last_run: { status: string | null; mode: string | null; created_at: string | null } | null;
  recovery_tests: ReadinessCount;
  kek: { configured: boolean; current_version: string; previous_configured: boolean };
  notes: string[];
};

async function countWhere(
  db: SupabaseClient,
  table: string,
  apply?: (q: any) => any,
): Promise<ReadinessCount> {
  try {
    let q = db.from(table).select("*", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

const DAY = 86_400_000;

export async function securityReadiness(db: SupabaseClient | null | undefined): Promise<SecurityReadiness> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const in30d = new Date(now + 30 * DAY).toISOString();
  const dayAgo = new Date(now - DAY).toISOString();

  const empty: SecurityReadiness = {
    configured: false,
    generated_at: nowIso,
    devices: { total: null, by_auth_method: {}, key_mode: { enc: null, legacy_hash: null, none: null } },
    credentials: { pending_rotations: null, expiring_within_30d: null, expired: null },
    device_auth_24h: { rejected: null, duplicate_message_rejections: null },
    active_elevations: null,
    bootstrap_grants: null,
    retention_last_run: null,
    recovery_tests: null,
    kek: kekStatus(),
    notes: ["Backend not configured — all counts unavailable."],
  };
  if (!db) return empty;

  const notes: string[] = [];

  // ── Devices: totals, auth_method distribution, credential key mode ──────
  const devicesTotal = await countWhere(db, "system_devices");
  const byAuthMethod: Record<string, ReadinessCount> = {};
  for (const m of DEVICE_AUTH_METHODS) {
    byAuthMethod[m] = await countWhere(db, "system_devices", (q) => q.eq("auth_method", m));
  }
  byAuthMethod.unset = await countWhere(db, "system_devices", (q) => q.is("auth_method", null));

  const encCount = await countWhere(db, "system_devices", (q) => q.not("device_secret_enc", "is", null));
  const legacyCount = await countWhere(db, "system_devices", (q) =>
    q.is("device_secret_enc", null).not("device_secret_hash", "is", null));
  const noneCount = await countWhere(db, "system_devices", (q) =>
    q.is("device_secret_enc", null).is("device_secret_hash", null));

  // ── Credential lifecycle ────────────────────────────────────────────────
  const pendingRotations = await countWhere(db, "system_devices", (q) => q.not("device_secret_enc_next", "is", null));
  const expiring30d = await countWhere(db, "system_devices", (q) =>
    q.not("credential_expires_at", "is", null).gt("credential_expires_at", nowIso).lt("credential_expires_at", in30d));
  const expiredCreds = await countWhere(db, "system_devices", (q) =>
    q.not("credential_expires_at", "is", null).lt("credential_expires_at", nowIso));

  // ── Device-auth telemetry (last 24h) ────────────────────────────────────
  const rejected24h = await countWhere(db, "system_device_messages", (q) =>
    q.eq("result", "rejected").gt("received_at", dayAgo));
  const dup24h = await countWhere(db, "system_device_messages", (q) =>
    q.eq("result", "rejected").eq("detail->>reason", "duplicate_message").gt("received_at", dayAgo));

  // ── Elevations / bootstrap / retention / recovery ───────────────────────
  const activeElevations = await countWhere(db, "system_elevations", (q) => q.gt("expires_at", nowIso));
  const bootstrapGrants = await countWhere(db, "system_bootstrap_grants");
  const recoveryTests = await countWhere(db, "system_recovery_tests");

  let retentionLastRun: SecurityReadiness["retention_last_run"] = null;
  try {
    const { data, error } = await db
      .from("system_retention_runs")
      .select("status,mode,created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      const r = data as { status?: string | null; mode?: string | null; created_at?: string | null };
      retentionLastRun = { status: r.status ?? null, mode: r.mode ?? null, created_at: r.created_at ?? null };
    }
  } catch { /* leave null */ }

  if (devicesTotal == null) notes.push("system_devices counts unavailable (table missing or query failed).");
  if (rejected24h == null) notes.push("system_device_messages unavailable — auth-failure counts unknown.");
  if (bootstrapGrants == null) notes.push("system_bootstrap_grants unavailable.");

  return {
    configured: true,
    generated_at: nowIso,
    devices: {
      total: devicesTotal,
      by_auth_method: byAuthMethod,
      key_mode: { enc: encCount, legacy_hash: legacyCount, none: noneCount },
    },
    credentials: {
      pending_rotations: pendingRotations,
      expiring_within_30d: expiring30d,
      expired: expiredCreds,
    },
    device_auth_24h: { rejected: rejected24h, duplicate_message_rejections: dup24h },
    active_elevations: activeElevations,
    bootstrap_grants: bootstrapGrants,
    retention_last_run: retentionLastRun,
    recovery_tests: recoveryTests,
    kek: kekStatus(),
    notes,
  };
}
