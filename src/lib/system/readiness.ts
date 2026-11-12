import type { SupabaseClient } from "@supabase/supabase-js";
import { DEVICE_AUTH_METHODS } from "./device-auth";
import { kekStatus } from "./device-auth";
import { kioskAdapterName } from "./kiosks";

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

/**
 * Lifecycle status vocabulary for readiness sections (Phase 2.3).
 *
 *  implemented         — code/schema exists; exercised indirectly.
 *  configured          — required configuration present (e.g. KEK set).
 *  test_verified       — unit/integration-tested; NOT yet exercised live.
 *  production_verified — verified against the real production environment.
 *  hardware_verified   — verified against a physical device. RESERVED: requires
 *                        real device evidence — never set without it.
 *  blocked             — cannot proceed until an external gate clears
 *                        (e.g. KIOSK_ADAPTER=none, pending change approval).
 *  unverified          — probe exists but has not confirmed the capability.
 *
 * HARD RULE: nothing in this file may emit production_verified or
 * hardware_verified today — there are zero physical devices and no live
 * end-to-end verification has been performed.
 */
export type ReadinessStatus =
  | "implemented"
  | "configured"
  | "test_verified"
  | "production_verified"
  | "hardware_verified"
  | "blocked"
  | "unverified";

export type ReadinessSection = {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
};

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
  /** Latest recorded recovery test (manually-entered — not independently verified). */
  recovery_last_test: { result: string | null; tested_at: string | null; environment: string | null } | null;
  /** Pending system_change_requests whose action relates to retention. */
  pending_retention_approvals: ReadinessCount;
  hardware: {
    /** KIOSK_ADAPTER env value as resolved ('none' | 'simulator' | …). */
    adapter: string;
    /** Rows in system_hardware_profiles (certification registry). */
    profiles: ReadinessCount;
  };
  /** Per-section lifecycle statuses — see ReadinessStatus docs above. */
  sections: ReadinessSection[];
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
    recovery_last_test: null,
    pending_retention_approvals: null,
    hardware: { adapter: kioskAdapterName(), profiles: null },
    sections: [],
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
  const hardwareProfiles = await countWhere(db, "system_hardware_profiles");
  // Retention execute is gated by assertApprovedOrRequest (action `retention.execute[:table]`,
  // status pending) — count those pending approvals honestly.
  const pendingRetentionApprovals = await countWhere(db, "system_change_requests", (q) =>
    q.eq("status", "pending").ilike("action", "retention%"));

  let recoveryLastTest: SecurityReadiness["recovery_last_test"] = null;
  try {
    const { data, error } = await db
      .from("system_recovery_tests")
      .select("result,tested_at,environment")
      .order("tested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      const r = data as { result?: string | null; tested_at?: string | null; environment?: string | null };
      recoveryLastTest = {
        result: r.result ?? null,
        tested_at: r.tested_at ?? null,
        environment: r.environment ?? null,
      };
    }
  } catch { /* leave null */ }

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
  if (pendingRetentionApprovals == null) notes.push("system_change_requests unavailable — pending retention approvals unknown.");
  if (hardwareProfiles == null) notes.push("system_hardware_profiles unavailable — certification registry unknown.");

  const adapter = kioskAdapterName();
  const kek = kekStatus();

  // ── Lifecycle sections ─────────────────────────────────────────────────
  // Honest mapping rules (Phase 2.3): unit-tested ≠ live-verified; no physical
  // devices exist, so nothing hardware-related may exceed 'test_verified', and
  // nothing may claim production_verified/hardware_verified at all today.
  const retentionExecuteBlocked =
    pendingRetentionApprovals == null || pendingRetentionApprovals > 0;
  const recoveryVerified =
    recoveryLastTest?.result === "passed" ? "test_verified" : "unverified";
  const sections: ReadinessSection[] = [
    {
      id: "schema_rls",
      label: "Schema & RLS",
      status: "implemented",
      detail: "Migrations 0001–0047 define the system tables with RLS enabled; verified via migrations manifest, not live policy probes.",
    },
    {
      id: "device_auth",
      label: "Device HMAC auth",
      status: "test_verified",
      detail: "HMAC-SHA256 device auth is implemented and unit-tested (tests/system-device-auth*); zero physical devices enrolled — not production-verified.",
    },
    {
      id: "device_credentials",
      label: "Device credential encryption",
      status: kek.configured ? "configured" : "unverified",
      detail: kek.configured
        ? `KEK v${kek.current_version} configured; enc/legacy key-mode counts probed live.`
        : "DEVICE_CREDENTIAL_KEK not configured — credential issuance fails closed.",
    },
    {
      id: "step_up",
      label: "MFA step-up elevation",
      status: "test_verified",
      detail: "TOTP verify → 15-minute system_elevations grant is unit-tested; live enrollment/step-up still pending authorized-admin validation (see checklist below).",
    },
    {
      id: "audit_log",
      label: "Audit log",
      status: "implemented",
      detail: "systemAudit writes accompany every privileged op; retention/audit tables are in the preserved class.",
    },
    {
      id: "retention_dry_run",
      label: "Retention dry-run",
      status: "test_verified",
      detail: "Bounded dry-run sweeps are implemented and unit-tested; deletes nothing.",
    },
    {
      id: "retention_execute",
      label: "Retention execute",
      status: retentionExecuteBlocked ? "blocked" : "unverified",
      detail: retentionExecuteBlocked
        ? `Execute requires an approved change request (assertApprovedOrRequest, risk=high). Pending retention approvals: ${pendingRetentionApprovals ?? "unknown"}.`
        : "No pending retention approvals — execute path available but never run live.",
    },
    {
      id: "backups_pitr",
      label: "Backups & PITR",
      status: "unverified",
      detail: "Provider-managed (Supabase). CLI probe 2026 Phase 2.3: region us-east-1, walg_enabled=true, pitr_enabled=false, backups=[] — confirm in Dashboard → Database → Backups.",
    },
    {
      id: "recovery_drill",
      label: "Recovery drill",
      status: recoveryVerified,
      detail:
        recoveryLastTest?.result === "passed"
          ? `Latest recorded test: passed (${recoveryLastTest.environment ?? "?"}, ${recoveryLastTest.tested_at ?? "?"}) — manually entered, not independently verified.`
          : "No passed restore test on record — recovery is NOT verified. See docs/RECOVERY.md.",
    },
    {
      id: "hardware_adapter",
      label: "Hardware adapter",
      status: adapter === "none" ? "blocked" : "unverified",
      detail:
        adapter === "none"
          ? "KIOSK_ADAPTER=none — NullKioskAdapter; no hardware path exists (dispense/reboot commands record adapter_disabled)."
          : `KIOSK_ADAPTER=${adapter} — selection recorded; no verified hardware adapter implementation.`,
    },
    {
      id: "hardware_profiles",
      label: "Hardware profiles",
      status: hardwareProfiles != null && hardwareProfiles > 0 ? "configured" : "unverified",
      detail:
        hardwareProfiles != null && hardwareProfiles > 0
          ? `${hardwareProfiles} profile(s) on file — certification status per row; capability claims still unverified without a live adapter.`
          : "system_hardware_profiles empty — no certified hardware inspected; capability claims unverified.",
    },
    {
      id: "hardware_fleet",
      label: "Hardware fleet verification",
      status: "unverified",
      detail: "Zero physical devices; no heartbeat/dispense evidence exists. Will remain 'unverified' until a real unit is enrolled and exercised.",
    },
  ];

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
    recovery_last_test: recoveryLastTest,
    pending_retention_approvals: pendingRetentionApprovals,
    hardware: { adapter, profiles: hardwareProfiles },
    sections,
    kek,
    notes,
  };
}
