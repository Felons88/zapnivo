import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/observability";
import { heartbeatStale, HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";
import { configStateDiff } from "./kiosk-detail";
import { parseCommissionPct } from "@/lib/ledgers";

/**
 * Alert sweep (Phase 2.5) — deferred ALERT_POLICY emitters that cannot fire
 * inline because they are aggregate/count-based signals. Runs from the
 * retention cron (src/app/api/cron/retention/route.ts) AFTER
 * sweepExpiredRotations and is skipped entirely on dry runs.
 *
 * Coverage (mirrors src/lib/system/obs-extra.ts ALERT_POLICY):
 *  - rental.exceptions_unresolved — rental_exceptions rows still 'open'
 *    older than EXCEPTION_STALE_HOURS (migration 0050).
 *  - device.missing_dispense_ack  — device_commands stuck 'queued'/'sent'
 *    past the ack window, plus system_device_commands pending/sent past
 *    timeout_at (or the same window when no timeout is recorded).
 *  - finance.unresolved_settlement — rentals sitting in a settlement-pending
 *    state (return_pending | overdue | non_return_fee_pending) older than
 *    SETTLEMENT_STALE_HOURS. There is no dedicated settlement table; these
 *    rental_state values ARE the unsettled-money signal (0013 enum).
 *  - device.offline_stale_heartbeat — enrolled devices (status active|
 *    testing) whose last_heartbeat_at is stale per heartbeatStale()
 *    (HEARTBEAT_STALE_MIN = 15 min).
 *
 * Phase 4.1 additions (same contract — aggregate/count probes, stable
 * fingerprints, PII-free messages, fault-tolerant 'skipped'):
 *  - deployment.failed — system_deployment_requests rows with
 *    status='failed' whose freshest timestamp (created_at/decided_at — the
 *    table has NO updated_at) is within RECENT_WINDOW_HOURS. One alert per
 *    request id. Limitation: a manual status flip that touches neither
 *    timestamp is not caught (no schema change made for this).
 *  - deployment.health_degraded — system_audit_events rows with
 *    action='deployment.health_degraded' (written by auditHealthProfile in
 *    deploy-health.ts on a degraded transition) within the window. One alert
 *    per distinct audit resource (health_profile:<app>), deduped in-sweep.
 *  - webhook.failures — inbound_jobs rows in status 'failed'/'dead' whose
 *    processed_at (fallback created_at) is within the window. One alert per
 *    job id. (inbound_emails 'error' rows are validation rejects, not delivery
 *    failures, so they are intentionally not alerted here.)
 *  - jobs.failed — three queue probes: cron_runs ok=false within the window
 *    (one alert per distinct job name), email_outbox status='failed' rows
 *    (one per row id), notification_jobs status='failed' rows (one per id).
 *  - device.credential_abuse — system_device_messages result='rejected'
 *    within CREDENTIAL_ABUSE_WINDOW_HOURS, grouped per device. Reasons that
 *    already have dedicated emitters/policy rules (credential_revoked,
 *    credential_expired, duplicate_message) are excluded. One alert per device
 *    once rejections reach CREDENTIAL_ABUSE_MIN_REJECTIONS.
 *
 * Phase 4.4 additions (same contract — aggregate probes, stable fingerprints,
 * PII-free messages, fault-tolerant 'skipped'):
 *  - update.rollout_failure / firmware.rollout_failure — kiosk_update_targets
 *    in 'failed'/'unknown_outcome' within RECENT_WINDOW_HOURS; release kind
 *    resolved via campaign → release lookup (firmware gets its own rule id).
 *  - update.campaign_blocked — kiosk_update_campaigns status='blocked' with
 *    updated_at within the window.
 *  - config.drift_detected — latest device_config_revisions per device whose
 *    reported config mismatches desired (configStateDiff, same rule as
 *    fleet-stats). reported===null is 'unreported', never drift.
 *  - finance.reconciliation_error — error-level app_logs mentioning
 *    'reconcil' within the window (e.g. rental_refund_reconcile_failed).
 *  - recovery.test_overdue — no system_recovery_tests row within
 *    RECOVERY_TEST_STALE_DAYS (reminder-level; backups are provider-managed).
 *
 * Phase 6 additions (business probes — same contract, aggregate/count signals,
 * stable fingerprints, PII-free messages, fault-tolerant 'skipped'):
 *  - finance.unreconciled_captured — payments captured >48h ago (real
 *    amount_captured_cents) whose rental is still in a pre-completion state
 *    (pending_payment | payment_authorized | authorized | dispense_pending |
 *    cancelled) or whose rental row is missing. In-flight states
 *    (active/return_pending/overdue/unreturned/…) are deliberately NOT
 *    flagged — they are covered by finance.unresolved_settlement and are
 *    legitimate. APPROXIMATION: event-pass/gift payments without a rental
 *    are excluded (rental_id null); one alert per payment id, capped.
 *  - finance.refund_spike — refunds created in the last 24h exceed
 *    REFUND_SPIKE_MULTIPLIER × the trailing-7-day daily average AND
 *    REFUND_SPIKE_MIN_LAST24 absolute. HEURISTIC: refunds are legit bursts
 *    (incident response, promo reversal); the message says so.
 *  - finance.payout_backlog — payout_records status='approved' whose
 *    approved_at (fallback created_at) is older than
 *    PAYOUT_APPROVED_STALE_DAYS, or status='scheduled' older than
 *    PAYOUT_SCHEDULED_STALE_DAYS (created_at). One alert per payout id.
 *  - finance.commission_drift — commission_ledgers rows whose
 *    commission_cents != round(gross_cents × pct/100) under the venue's
 *    LATEST known agreement pct (venue agreement wins over org agreement;
 *    same parseCommissionPct rule as ledgers.ts). HEURISTIC: agreements can
 *    change mid-history and period timing is not modelled, so this flags
 *    candidates for review, not proven errors. Skips venues with no rate.
 *  - ops.rental_decline — rentals created in the last 7d are <50% of the
 *    prior 7d AND the prior 7d had >=10 rentals (noise guard for tiny
 *    volumes). One stable alert per sweep window.
 *  - ops.inventory_mismatch — kiosk_slots with an occupied state whose
 *    power_bank_id set disagrees with power_banks.current_kiosk (non-retired)
 *    beyond INVENTORY_MISMATCH_TOLERANCE bank ids per kiosk. Catches slot↔bank
 *    drift in both directions. One alert per kiosk id.
 *
 * Every probe is fault-tolerant: a missing table/column or query error marks
 * that check 'skipped' — the sweep NEVER throws and never crashes the cron.
 * Emissions go through reportError → error_events/error_issues, fingerprinted
 * per entity (stable message = one grouped issue per exception/command/
 * rental/device). Messages carry ids + coarse codes only — no PII, no secrets.
 */

export const EXCEPTION_STALE_HOURS = 24;
export const SETTLEMENT_STALE_HOURS = 24;
export const COMMAND_STUCK_MINUTES = 10;
/** Phase 4.1: recency window for deployment/webhook/job failure probes. */
export const RECENT_WINDOW_HOURS = 24;
/** Phase 4.1: device auth-failure burst threshold + window. */
export const CREDENTIAL_ABUSE_MIN_REJECTIONS = 5;
export const CREDENTIAL_ABUSE_WINDOW_HOURS = 24;
/** Phase 4.4: recovery-test freshness target + config-drift scan bounds. */
export const RECOVERY_TEST_STALE_DAYS = 90;
export const CONFIG_DRIFT_SCAN_LIMIT = 500;
export const UPDATE_TARGET_SCAN_LIMIT = 100;
/** Max rows inspected/emitted per check — bounds cron runtime and alert volume. */
export const ALERT_SWEEP_ROW_CAP = 25;
/** Device scan is wider (need the full enrolled fleet to find stale ones). */
const DEVICE_SCAN_LIMIT = 200;
/** Wider scan for auth-rejection telemetry (need per-device counts). */
const MESSAGE_SCAN_LIMIT = 500;

/* ── Phase 6: business probe thresholds (pure helpers are unit-tested) ── */
/** Captured payments older than this with a stuck pre-completion rental. */
export const UNRECONCILED_CAPTURED_HOURS = 48;
/** Refund spike: last-24h count must beat multiplier × trailing-7d daily avg. */
export const REFUND_SPIKE_MIN_LAST24 = 3;
export const REFUND_SPIKE_MULTIPLIER = 3;
export const REFUND_SPIKE_BASELINE_DAYS = 7;
/** Payout backlog age limits per status. */
export const PAYOUT_APPROVED_STALE_DAYS = 7;
export const PAYOUT_SCHEDULED_STALE_DAYS = 14;
/** Rental decline: recent 7d < RATIO × prior 7d, prior 7d >= MIN baseline. */
export const RENTAL_DECLINE_WINDOW_DAYS = 7;
export const RENTAL_DECLINE_MIN_BASELINE = 10;
export const RENTAL_DECLINE_RATIO = 0.5;
/** Inventory: allowed bank-id symmetric difference per kiosk before alerting. */
export const INVENTORY_MISMATCH_TOLERANCE = 1;
/** Bounded scans for the business probes. */
export const BUSINESS_SCAN_LIMIT = 500;
export const REFUND_SCAN_LIMIT = 1000;
export const INVENTORY_SCAN_LIMIT = 2000;

/** Rental states that mean "money/return resolution still outstanding". */
export const SETTLEMENT_PENDING_STATES = [
  "return_pending",
  "overdue",
  "non_return_fee_pending",
] as const;

export type AlertSweepCheck =
  | { status: "ok"; matched: number; emitted: number }
  | { status: "skipped"; reason: string };

export type AlertSweepSummary = {
  ok: boolean;
  emitted: number;
  checks: Record<string, AlertSweepCheck>;
};

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;

/* ── Phase 6 pure decision helpers (exported for tests/business-alerts) ── */

/**
 * Rental states where a captured payment is legitimately still in flight OR
 * already resolved elsewhere: active/return_pending/overdue/unreturned/
 * non_return_fee_pending are covered by finance.unresolved_settlement;
 * returned/non_return_fee_paid/charged_off/closed are completed; disputed has
 * its own dispute workflow. Only the states below mean "money captured but
 * the rental never got going / was cancelled with money attached".
 */
export const UNRECONCILED_CAPTURED_STATES = new Set([
  "pending_payment",
  "payment_authorized",
  "authorized",
  "dispense_pending",
  "cancelled",
]);

/**
 * Payment ids that look captured-but-never-completed. Payments without a
 * rental_id (event passes, gifts, …) are excluded — they cannot be
 * attributed to a rental lifecycle. A payment whose rental row is missing
 * from stateByRental IS flagged (orphaned money is exactly the anomaly).
 */
export function unreconciledPaymentIds(
  payments: { id: string; rental_id: string | null }[],
  stateByRental: ReadonlyMap<string, string | null>,
): string[] {
  const out: string[] = [];
  for (const p of payments) {
    if (!p.rental_id) continue;
    const state = stateByRental.get(p.rental_id);
    if (state === undefined || (state != null && UNRECONCILED_CAPTURED_STATES.has(state))) out.push(p.id);
  }
  return out;
}

/** Refund spike: last-24h count must clear BOTH the absolute floor and the
 *  multiplier × trailing-7-day daily average (baseline excludes the last 24h). */
export function refundSpikeHit(last24Count: number, baseline7Count: number): boolean {
  return (
    last24Count >= REFUND_SPIKE_MIN_LAST24 &&
    last24Count > REFUND_SPIKE_MULTIPLIER * (baseline7Count / REFUND_SPIKE_BASELINE_DAYS)
  );
}

/** Payout backlog: 'approved' ages from approved_at (created_at fallback);
 *  'scheduled' ages from created_at. Other statuses never backlog. */
export function payoutBacklogHit(
  status: string,
  approvedAt: string | null,
  createdAt: string | null,
  nowMs: number,
): boolean {
  if (status === "approved") {
    const t = Date.parse(approvedAt ?? createdAt ?? "");
    return Number.isFinite(t) && t < nowMs - PAYOUT_APPROVED_STALE_DAYS * DAY;
  }
  if (status === "scheduled") {
    const t = Date.parse(createdAt ?? "");
    return Number.isFinite(t) && t < nowMs - PAYOUT_SCHEDULED_STALE_DAYS * DAY;
  }
  return false;
}

/** Rental decline: prior week must be big enough to be meaningful. */
export function rentalDeclineHit(recent7: number, prior7: number): boolean {
  return prior7 >= RENTAL_DECLINE_MIN_BASELINE && recent7 < prior7 * RENTAL_DECLINE_RATIO;
}

export type InventorySlotRow = { kiosk_id: string; state: string | null; power_bank_id: string | null };
export type InventoryBankRow = { id: string; current_kiosk: string | null; retired: boolean | null };

/**
 * Kiosks where the set of banks docked in occupied slots disagrees with the
 * set of non-retired banks reporting current_kiosk = that kiosk, beyond
 * `tolerance` bank ids (symmetric difference). 'empty' slots and null
 * power_bank_id contribute nothing; retired banks are ignored.
 */
export function inventoryMismatchKiosks(
  slots: InventorySlotRow[],
  banks: InventoryBankRow[],
  tolerance = INVENTORY_MISMATCH_TOLERANCE,
): string[] {
  const addTo = (m: Map<string, Set<string>>, k: string, v: string) => {
    let s = m.get(k);
    if (!s) { s = new Set(); m.set(k, s); }
    s.add(v);
  };
  const slotBanks = new Map<string, Set<string>>();
  const kioskBanks = new Map<string, Set<string>>();
  for (const s of slots) {
    if (s.state === "empty" || !s.power_bank_id) continue;
    addTo(slotBanks, s.kiosk_id, s.power_bank_id);
  }
  for (const b of banks) {
    if (b.retired || !b.current_kiosk) continue;
    addTo(kioskBanks, b.current_kiosk, b.id);
  }
  const kioskIds = new Set([...slotBanks.keys(), ...kioskBanks.keys()]);
  const out: string[] = [];
  for (const k of kioskIds) {
    const docked = slotBanks.get(k) ?? new Set<string>();
    const reported = kioskBanks.get(k) ?? new Set<string>();
    let diff = 0;
    for (const id of docked) if (!reported.has(id)) diff += 1;
    for (const id of reported) if (!docked.has(id)) diff += 1;
    if (diff > tolerance) out.push(k);
  }
  return out.sort();
}

/** Commission drift candidates: ledger commission != round(gross × pct/100)
 *  under the venue's latest agreement pct. Venues without a known rate are
 *  skipped (no default rate exists — see ledgers.ts). */
export function commissionDriftIds(
  ledgers: { id: string; venue_id: string; gross_cents: number | null; commission_cents: number | null }[],
  pctByVenue: ReadonlyMap<string, number>,
): string[] {
  return ledgers
    .filter((l) => {
      const pct = pctByVenue.get(l.venue_id);
      if (pct == null) return false;
      return (l.commission_cents ?? 0) !== Math.round(((l.gross_cents ?? 0) * pct) / 100);
    })
    .map((l) => l.id);
}

/** Fire-and-forget alert emit. Message MUST stay stable per entity — the
 *  observability fingerprint is derived from it, so counts/ages would defeat
 *  dedup. Scope ids (uuid/uid/kind/state) are operational metadata, not PII. */
function emit(message: string): void {
  reportError(new Error(message), { severity: "warning", route: "cron.alert_sweep" });
}

type QueryResult = { data: unknown; error: { message?: string } | null };

/** Runs one probe; ANY failure (missing table/column, network) → skipped. */
async function probe<T>(fn: () => PromiseLike<QueryResult>): Promise<{ ok: true; rows: T[] } | { ok: false; reason: string }> {
  try {
    const { data, error } = await fn();
    if (error) return { ok: false, reason: error.message ?? "query failed" };
    return { ok: true, rows: Array.isArray(data) ? (data as T[]) : [] };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "query failed" };
  }
}

export async function runAlertSweep(
  db: SupabaseClient,
  now = new Date(),
): Promise<AlertSweepSummary> {
  const checks: Record<string, AlertSweepCheck> = {};
  let emitted = 0;
  const bump = () => { emitted += 1; };

  const nowMs = now.getTime();
  const exceptionCutoff = new Date(nowMs - EXCEPTION_STALE_HOURS * HOUR).toISOString();
  const settlementCutoff = new Date(nowMs - SETTLEMENT_STALE_HOURS * HOUR).toISOString();
  const commandCutoff = new Date(nowMs - COMMAND_STUCK_MINUTES * MIN).toISOString();
  const recentCutoff = new Date(nowMs - RECENT_WINDOW_HOURS * HOUR).toISOString();
  const recentCutoffMs = nowMs - RECENT_WINDOW_HOURS * HOUR;
  const abuseCutoff = new Date(nowMs - CREDENTIAL_ABUSE_WINDOW_HOURS * HOUR).toISOString();

  /* ── rental.exceptions_unresolved ─────────────────────────────────────── */
  {
    const name = "rental_exceptions_unresolved";
    const res = await probe<{ id: string; kind: string | null }>(() =>
      db
        .from("rental_exceptions")
        .select("id,kind")
        .eq("status", "open")
        .lt("created_at", exceptionCutoff)
        .limit(ALERT_SWEEP_ROW_CAP),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      let n = 0;
      for (const row of res.rows.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`rental.exceptions_unresolved exception=${row.id} kind=${row.kind ?? "unknown"}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: res.rows.length, emitted: n };
    }
  }

  /* ── device.missing_dispense_ack — public device_commands queue ────────── */
  {
    const name = "device_commands_stuck";
    const res = await probe<{ id: string }>(() =>
      db
        .from("device_commands")
        .select("id")
        .in("status", ["queued", "sent"])
        .lt("created_at", commandCutoff)
        .limit(ALERT_SWEEP_ROW_CAP),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      let n = 0;
      for (const row of res.rows.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`device.missing_dispense_ack command=${row.id} table=device_commands`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: res.rows.length, emitted: n };
    }
  }

  /* ── device.missing_dispense_ack — system_device_commands queue ──────────
     Defensive: timeout_at may be null (0052 adds ack columns); a pending/sent
     command with no recorded timeout is stuck once it is older than the ack
     window. Column absence → the whole probe is skipped, never fatal. */
  {
    const name = "system_device_commands_stuck";
    const res = await probe<{ id: string; state: string | null; timeout_at: string | null; created_at: string | null }>(() =>
      db
        .from("system_device_commands")
        .select("id,state,timeout_at,created_at")
        .in("state", ["pending", "sent"])
        .limit(100),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const stuck = res.rows.filter((r) => {
        const t = r.timeout_at ? Date.parse(r.timeout_at) : NaN;
        if (Number.isFinite(t)) return t < nowMs;
        const c = r.created_at ? Date.parse(r.created_at) : NaN;
        return Number.isFinite(c) ? c < nowMs - COMMAND_STUCK_MINUTES * MIN : false;
      });
      let n = 0;
      for (const row of stuck.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`device.missing_dispense_ack command=${row.id} table=system_device_commands state=${row.state ?? "unknown"}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: stuck.length, emitted: n };
    }
  }

  /* ── finance.unresolved_settlement — rentals awaiting settlement ─────────
     rentals.state is the settlement signal: return_pending / overdue /
     non_return_fee_pending all mean the money/return resolution is still
     open. Older than SETTLEMENT_STALE_HOURS → one alert per rental id. */
  {
    const name = "unresolved_settlements";
    const res = await probe<{ id: string; state: string | null }>(() =>
      db
        .from("rentals")
        .select("id,state")
        .in("state", [...SETTLEMENT_PENDING_STATES])
        .lt("created_at", settlementCutoff)
        .limit(ALERT_SWEEP_ROW_CAP),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      let n = 0;
      for (const row of res.rows.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`finance.unresolved_settlement rental=${row.id} state=${row.state ?? "unknown"}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: res.rows.length, emitted: n };
    }
  }

  /* ── device.offline_stale_heartbeat — enrolled devices with stale beat ─── */
  {
    const name = "offline_devices";
    const res = await probe<{ id: string; device_uid: string | null; last_heartbeat_at: string | null }>(() =>
      db
        .from("system_devices")
        .select("id,device_uid,last_heartbeat_at")
        .in("status", ["active", "testing"])
        .limit(DEVICE_SCAN_LIMIT),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const stale = res.rows.filter((r) => heartbeatStale(r.last_heartbeat_at, now));
      let n = 0;
      for (const row of stale.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`device.offline_stale_heartbeat device=${row.device_uid ?? row.id}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: stale.length, emitted: n };
    }
  }

  /* ── integrations.health — daily provider probe (D14) ──────────────────
     Runs the same bounded checkIntegrationHealth used by the admin console.
     Only 'degraded' emits an alert — 'unconfigured'/'requires_credentials' are
     config state, not failures, and 'unknown' means "could not verify" (e.g.
     idle kiosk gateway), which would be noisy. Dynamic import keeps the heavy
     provider clients out of the sweep's static graph; the whole probe is
     try/catch — it can never break the cron. */
  {
    const name = "integration_health";
    try {
      const { checkIntegrationHealth, INTEGRATION_PROVIDERS } = await import("@/lib/system/integrations");
      const results = await Promise.all(
        INTEGRATION_PROVIDERS.map((p) => checkIntegrationHealth(p.id, db).catch(() => null)),
      );
      const degraded = results.filter((r) => r?.status === "degraded");
      // Nothing configured anywhere → the probe is a no-op, report 'skipped'
      // (same contract as the table probes on missing schemas).
      const anyConfigured = results.some((r) => r && r.status !== "unconfigured" && r.status !== "requires_credentials");
      if (!anyConfigured) {
        checks[name] = { status: "skipped", reason: "no providers configured" };
      } else {
        let n = 0;
        for (const r of degraded.slice(0, ALERT_SWEEP_ROW_CAP)) {
          // Stable per-provider message — fingerprint dedupes repeat sweeps.
          emit(`integrations.health provider=${r!.provider} status=degraded`);
          n += 1;
          bump();
        }
        checks[name] = { status: "ok", matched: degraded.length, emitted: n };
      }
    } catch (e) {
      checks[name] = { status: "skipped", reason: e instanceof Error ? e.message : "integration probe failed" };
    }
  }

  /* ── Phase 4.1 probes ──────────────────────────────────────────────────── */

  /* ── deployment.failed — failed deployment requests, recent ──────────────
     system_deployment_requests has no updated_at; 'failed' is a terminal
     status recorded after a real deploy attempt. Recency = freshest of
     created_at/decided_at within RECENT_WINDOW_HOURS. */
  {
    const name = "deployment_failed";
    const res = await probe<{ id: string; action: string | null; created_at: string | null; decided_at: string | null }>(() =>
      db
        .from("system_deployment_requests")
        .select("id,action,created_at,decided_at")
        .eq("status", "failed")
        .limit(ALERT_SWEEP_ROW_CAP),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const recent = res.rows.filter((r) => {
        const stamps = [r.created_at, r.decided_at]
          .map((s) => (s ? Date.parse(s) : NaN))
          .filter((t) => Number.isFinite(t));
        return stamps.length > 0 && Math.max(...stamps) >= recentCutoffMs;
      });
      let n = 0;
      for (const row of recent.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`deployment.failed request=${row.id} action=${row.action ?? "unknown"}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: recent.length, emitted: n };
    }
  }

  /* ── deployment.health_degraded — degraded health-profile transitions ────
     auditHealthProfile (deploy-health.ts) writes action='deployment.health_degraded'
     to system_audit_events on a degraded verdict. One alert per distinct
     resource (health_profile:<app>); repeat transitions for the same app
     dedupe to the same fingerprint. */
  {
    const name = "deployment_health_degraded";
    const res = await probe<{ resource: string | null }>(() =>
      db
        .from("system_audit_events")
        .select("resource")
        .eq("action", "deployment.health_degraded")
        .gte("created_at", recentCutoff)
        .limit(ALERT_SWEEP_ROW_CAP),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const targets = [...new Set(res.rows.map((r) => r.resource).filter((r): r is string => typeof r === "string" && r.length > 0))];
      let n = 0;
      for (const target of targets.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`deployment.health_degraded target=${target}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: res.rows.length, emitted: n };
    }
  }

  /* ── webhook.failures — dead/failed inbound email jobs ───────────────────
     inbound_jobs is the durable queue drained by /api/cron/inbound; 'failed'
     is in the CHECK constraint (worker primarily writes 'dead'). Recency uses
     processed_at with created_at fallback, judged in JS (bounded scan). */
  {
    const name = "webhook_inbound_failures";
    const res = await probe<{ id: string; status: string | null; created_at: string | null; processed_at: string | null }>(() =>
      db
        .from("inbound_jobs")
        .select("id,status,created_at,processed_at")
        .in("status", ["failed", "dead"])
        .limit(100),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const recent = res.rows.filter((r) => {
        const t = Date.parse(r.processed_at ?? r.created_at ?? "");
        return Number.isFinite(t) && t >= recentCutoffMs;
      });
      let n = 0;
      for (const row of recent.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`webhook.failures job=${row.id} status=${row.status ?? "unknown"}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: recent.length, emitted: n };
    }
  }

  /* ── jobs.failed — cron_runs failures (one alert per distinct job) ──────── */
  {
    const name = "cron_job_failures";
    const res = await probe<{ job: string | null }>(() =>
      db
        .from("cron_runs")
        .select("job")
        .eq("ok", false)
        .gte("ran_at", recentCutoff)
        .limit(200),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const jobs = [...new Set(res.rows.map((r) => r.job).filter((j): j is string => typeof j === "string" && j.length > 0))];
      let n = 0;
      for (const job of jobs.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`jobs.failed job=${job} source=cron_runs`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: res.rows.length, emitted: n };
    }
  }

  /* ── jobs.failed — email_outbox permanent failures ─────────────────────── */
  {
    const name = "email_outbox_failures";
    const res = await probe<{ id: string }>(() =>
      db
        .from("email_outbox")
        .select("id")
        .eq("status", "failed")
        .gte("created_at", recentCutoff)
        .limit(ALERT_SWEEP_ROW_CAP),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      let n = 0;
      for (const row of res.rows.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`jobs.failed email_outbox=${row.id} source=email_outbox`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: res.rows.length, emitted: n };
    }
  }

  /* ── jobs.failed — notification_jobs failures ──────────────────────────── */
  {
    const name = "notification_job_failures";
    const res = await probe<{ id: string }>(() =>
      db
        .from("notification_jobs")
        .select("id")
        .eq("status", "failed")
        .gte("created_at", recentCutoff)
        .limit(ALERT_SWEEP_ROW_CAP),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      let n = 0;
      for (const row of res.rows.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`jobs.failed notification_job=${row.id} source=notification_jobs`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: res.rows.length, emitted: n };
    }
  }

  /* ── device.credential_abuse — repeated device auth rejections ────────────
     Groups rejected system_device_messages rows per device over
     CREDENTIAL_ABUSE_WINDOW_HOURS. Reasons with dedicated emitters/policy
     (credential_revoked, credential_expired, duplicate_message) are excluded
     so this probe only catches unexplained failure bursts (bad signatures,
     unknown devices, missing credentials, …). One alert per device once the
     count reaches CREDENTIAL_ABUSE_MIN_REJECTIONS; the message stays stable
     (no counts) so the fingerprint dedups repeat sweeps. */
  {
    const name = "device_credential_abuse";
    const ABUSE_EXCLUDED_REASONS = new Set(["credential_revoked", "credential_expired", "duplicate_message"]);
    const res = await probe<{ device_id: string | null; detail: Record<string, unknown> | null }>(() =>
      db
        .from("system_device_messages")
        .select("device_id,detail")
        .eq("result", "rejected")
        .gte("received_at", abuseCutoff)
        .limit(MESSAGE_SCAN_LIMIT),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const counts = new Map<string, number>();
      for (const row of res.rows) {
        const reason = typeof row.detail?.reason === "string" ? row.detail.reason : "";
        if (ABUSE_EXCLUDED_REASONS.has(reason)) continue;
        const uid = typeof row.detail?.device_uid === "string" ? row.detail.device_uid : null;
        const scope = row.device_id ?? uid ?? "unattributed";
        counts.set(scope, (counts.get(scope) ?? 0) + 1);
      }
      const abusive = [...counts.entries()].filter(([, c]) => c >= CREDENTIAL_ABUSE_MIN_REJECTIONS);
      let n = 0;
      for (const [scope] of abusive.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`device.credential_abuse device=${scope}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: res.rows.length, emitted: n };
    }
  }

  /* ── Phase 4.4 probes ──────────────────────────────────────────────────── */

  /* ── update.rollout_failure / firmware.rollout_failure — kiosk_update_targets
     in 'failed'/'unknown_outcome' touched within RECENT_WINDOW_HOURS. The
     release kind is resolved via kiosk_update_campaigns → kiosk_update_releases
     (two bounded follow-up lookups, each fault-tolerant — an unavailable
     lookup degrades kind to 'unknown' and the target still alerts as a
     software rollout failure). One alert per target id; the message is stable
     (no counts/ages) so the fingerprint dedupes repeat sweeps. */
  {
    const name = "update_rollout_failures";
    const res = await probe<{ id: string; campaign_id: string | null; state: string | null; updated_at: string | null; state_entered_at: string | null }>(() =>
      db
        .from("kiosk_update_targets")
        .select("id,campaign_id,state,updated_at,state_entered_at")
        .in("state", ["failed", "unknown_outcome"])
        .limit(UPDATE_TARGET_SCAN_LIMIT),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const recent = res.rows.filter((r) => {
        const stamps = [r.updated_at, r.state_entered_at]
          .map((s) => (s ? Date.parse(s) : NaN))
          .filter((t) => Number.isFinite(t));
        return stamps.length > 0 && Math.max(...stamps) >= recentCutoffMs;
      });
      // Resolve release kinds in two bounded hops (campaign → release).
      const kindByTarget = new Map<string, string>();
      if (recent.length > 0) {
        const campaignIds = [...new Set(recent.map((r) => r.campaign_id).filter((c): c is string => typeof c === "string" && c.length > 0))];
        if (campaignIds.length > 0) {
          const campRes = await probe<{ id: string; release_id: string | null }>(() =>
            db.from("kiosk_update_campaigns").select("id,release_id").in("id", campaignIds).limit(200),
          );
          if (campRes.ok) {
            const releaseByCampaign = new Map(campRes.rows.map((c) => [c.id, c.release_id]));
            const releaseIds = [...new Set([...releaseByCampaign.values()].filter((r): r is string => typeof r === "string" && r.length > 0))];
            const kindByRelease = new Map<string, string>();
            if (releaseIds.length > 0) {
              const relRes = await probe<{ id: string; kind: string | null }>(() =>
                db.from("kiosk_update_releases").select("id,kind").in("id", releaseIds).limit(200),
              );
              if (relRes.ok) for (const r of relRes.rows) kindByRelease.set(r.id, r.kind ?? "unknown");
            }
            for (const t of recent) {
              const relId = t.campaign_id ? releaseByCampaign.get(t.campaign_id) : null;
              kindByTarget.set(t.id, (relId && kindByRelease.get(relId)) || "unknown");
            }
          }
        }
      }
      let n = 0;
      for (const row of recent.slice(0, ALERT_SWEEP_ROW_CAP)) {
        const kind = kindByTarget.get(row.id) ?? "unknown";
        if (kind === "firmware") emit(`firmware.rollout_failure target=${row.id} state=${row.state ?? "unknown"}`);
        else emit(`update.rollout_failure target=${row.id} kind=${kind} state=${row.state ?? "unknown"}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: recent.length, emitted: n };
    }
  }

  /* ── update.campaign_blocked — campaigns parked in 'blocked' recently ────
     kiosk_update_campaigns.status includes 'blocked' (0067). Recency uses
     updated_at within RECENT_WINDOW_HOURS; one alert per campaign id. */
  {
    const name = "update_campaign_blocked";
    const res = await probe<{ id: string; updated_at: string | null }>(() =>
      db
        .from("kiosk_update_campaigns")
        .select("id,updated_at")
        .eq("status", "blocked")
        .gte("updated_at", recentCutoff)
        .limit(ALERT_SWEEP_ROW_CAP),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      let n = 0;
      for (const row of res.rows.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`update.campaign_blocked campaign=${row.id}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: res.rows.length, emitted: n };
    }
  }

  /* ── config.drift_detected — latest device_config_revisions per device
     whose reported config mismatches desired (same configStateDiff rule as
     fleet-stats). reported===null is 'unreported', NOT drift — the reported
     channel does not exist in ingest today, so this probe honestly matches
     zero rows until it does. Bounded scan, sorted by revision desc in JS so
     stub-independent ordering holds; one alert per drifted device. */
  {
    const name = "config_drift";
    const res = await probe<{ device_id: string; revision: number; desired: Record<string, unknown> | null; status: string | null; reported: Record<string, unknown> | null }>(() =>
      db
        .from("device_config_revisions")
        .select("device_id,revision,desired,status,reported")
        .order("revision", { ascending: false })
        .limit(CONFIG_DRIFT_SCAN_LIMIT),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const sorted = [...res.rows].sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));
      const latestSeen = new Set<string>();
      const drifted: string[] = [];
      for (const r of sorted) {
        if (latestSeen.has(r.device_id)) continue;
        latestSeen.add(r.device_id);
        if (r.reported != null && configStateDiff(r.desired, r.reported).summary === "mismatch") drifted.push(r.device_id);
      }
      let n = 0;
      for (const deviceId of drifted.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`config.drift_detected device=${deviceId}`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: drifted.length, emitted: n };
    }
  }

  /* ── finance.reconciliation_error — error-level app_logs whose message
     mentions reconciliation (e.g. rental_refund_reconcile_failed written by
     src/lib/payments/refund.ts). One stable alert per sweep window — the
     fingerprint groups repeats; per-row ids are intentionally NOT in the
     message (they would defeat dedup). */
  {
    const name = "finance_reconciliation";
    const res = await probe<{ id: number; message: string | null }>(() =>
      db
        .from("app_logs")
        .select("id,message")
        .eq("level", "error")
        .gte("ts", recentCutoff)
        .limit(200),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const hits = res.rows.filter((r) => typeof r.message === "string" && /reconcil/i.test(r.message));
      let n = 0;
      if (hits.length > 0) {
        emit(`finance.reconciliation_error source=app_logs`);
        n = 1;
        bump();
      }
      checks[name] = { status: "ok", matched: hits.length, emitted: n };
    }
  }

  /* ── recovery.test_overdue — no system_recovery_tests row within
     RECOVERY_TEST_STALE_DAYS (or the table is empty). Reminder-level: the
     sweep emits one stable alert; backups themselves are provider-managed
     and unverifiable from the app (see src/lib/system/recovery.ts). */
  {
    const name = "recovery_test_overdue";
    const res = await probe<{ tested_at: string | null }>(() =>
      db
        .from("system_recovery_tests")
        .select("tested_at")
        .order("tested_at", { ascending: false })
        .limit(50),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const stamps = res.rows.map((r) => (r.tested_at ? Date.parse(r.tested_at) : NaN)).filter((t) => Number.isFinite(t));
      const latest = stamps.length ? Math.max(...stamps) : NaN;
      const staleDays = RECOVERY_TEST_STALE_DAYS * 24 * HOUR;
      const overdue = !Number.isFinite(latest) || latest < nowMs - staleDays;
      let n = 0;
      if (overdue) {
        emit(`recovery.test_overdue window_days=${RECOVERY_TEST_STALE_DAYS}`);
        n = 1;
        bump();
      }
      checks[name] = { status: "ok", matched: overdue ? 1 : 0, emitted: n };
    }
  }

  /* ── Phase 6: business probes ──────────────────────────────────────────── */

  /* ── finance.unreconciled_captured — captured money on rentals that never
     reached a completed/fee state. Two bounded queries: captured payments
     older than UNRECONCILED_CAPTURED_HOURS, then their rental states. Only
     pre-completion states (UNRECONCILED_CAPTURED_STATES) or a missing rental
     row count — in-flight states belong to finance.unresolved_settlement.
     One alert per payment id; evidence link is a sanitized admin path. */
  {
    const name = "unreconciled_captured";
    const cutoff = new Date(nowMs - UNRECONCILED_CAPTURED_HOURS * HOUR).toISOString();
    const pays = await probe<{ id: string; rental_id: string | null }>(() =>
      db
        .from("payments")
        .select("id,rental_id")
        .gt("amount_captured_cents", 0)
        .lt("captured_at", cutoff)
        .limit(BUSINESS_SCAN_LIMIT),
    );
    if (!pays.ok) {
      checks[name] = { status: "skipped", reason: pays.reason };
    } else {
      const rentalIds = [...new Set(pays.rows.map((p) => p.rental_id).filter((r): r is string => typeof r === "string" && r.length > 0))];
      const states = new Map<string, string | null>();
      let lookupFailed: string | null = null;
      for (let i = 0; i < rentalIds.length && !lookupFailed; i += 200) {
        const chunk = rentalIds.slice(i, i + 200);
        const res = await probe<{ id: string; state: string | null }>(() =>
          db.from("rentals").select("id,state").in("id", chunk).limit(200),
        );
        if (!res.ok) lookupFailed = res.reason;
        else for (const r of res.rows) states.set(r.id, r.state);
      }
      if (lookupFailed) {
        checks[name] = { status: "skipped", reason: `rental lookup failed: ${lookupFailed}` };
      } else {
        const ids = unreconciledPaymentIds(pays.rows, states);
        let n = 0;
        for (const id of ids.slice(0, ALERT_SWEEP_ROW_CAP)) {
          emit(`finance.unreconciled_captured payment=${id} window_hours=${UNRECONCILED_CAPTURED_HOURS} evidence=/admin/finance`);
          n += 1;
          bump();
        }
        checks[name] = { status: "ok", matched: ids.length, emitted: n };
      }
    }
  }

  /* ── finance.refund_spike — heuristic: last-24h refunds vs the trailing
     7-day daily average (baseline = the 7 days BEFORE the last 24h, so the
     windows don't overlap). One stable alert — counts are deliberately NOT
     in the message (fingerprint dedup). */
  {
    const name = "refund_spike";
    const scanStart = new Date(nowMs - (REFUND_SPIKE_BASELINE_DAYS + 1) * DAY).toISOString();
    const res = await probe<{ id: string; created_at: string | null }>(() =>
      db
        .from("refunds")
        .select("id,created_at")
        .gte("created_at", scanStart)
        .limit(REFUND_SCAN_LIMIT),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      let last24 = 0, baseline = 0;
      for (const r of res.rows) {
        const t = r.created_at ? Date.parse(r.created_at) : NaN;
        if (!Number.isFinite(t)) continue;
        if (t >= nowMs - DAY) last24 += 1;
        else if (t >= nowMs - (REFUND_SPIKE_BASELINE_DAYS + 1) * DAY) baseline += 1;
      }
      const hit = refundSpikeHit(last24, baseline);
      let n = 0;
      if (hit) {
        emit(`finance.refund_spike heuristic=trailing_7d evidence=/admin/support/refunds`);
        n = 1;
        bump();
      }
      checks[name] = { status: "ok", matched: hit ? 1 : 0, emitted: n };
    }
  }

  /* ── finance.payout_backlog — approved payouts unpaid >7d, scheduled
     payouts untouched >14d. One alert per payout id. */
  {
    const name = "payout_backlog";
    const res = await probe<{ id: string; status: string | null; created_at: string | null; approved_at: string | null }>(() =>
      db
        .from("payout_records")
        .select("id,status,created_at,approved_at")
        .in("status", ["scheduled", "approved"])
        .limit(BUSINESS_SCAN_LIMIT),
    );
    if (!res.ok) {
      checks[name] = { status: "skipped", reason: res.reason };
    } else {
      const stale = res.rows.filter((r) =>
        payoutBacklogHit(r.status ?? "", r.approved_at, r.created_at, nowMs),
      );
      let n = 0;
      for (const row of stale.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`finance.payout_backlog payout=${row.id} status=${row.status ?? "unknown"} evidence=/admin/payouts`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: stale.length, emitted: n };
    }
  }

  /* ── finance.commission_drift — ledger commission vs latest agreement pct.
     HEURISTIC: pct comes from the venue's newest agreement (venue-level beats
     org-level); agreements can change mid-history so this flags review
     candidates, not proven errors. Venues without a rate are skipped — there
     is no default commission (ledgers.ts). Bounded: recent ledgers only. */
  {
    const name = "commission_drift";
    const ledgersRes = await probe<{ id: string; venue_id: string; gross_cents: number | null; commission_cents: number | null }>(() =>
      db
        .from("commission_ledgers")
        .select("id,venue_id,gross_cents,commission_cents")
        .order("period", { ascending: false })
        .limit(200),
    );
    if (!ledgersRes.ok) {
      checks[name] = { status: "skipped", reason: ledgersRes.reason };
    } else {
      const agreementsRes = await probe<{ venue_id: string | null; organization_id: string | null; terms: unknown }>(() =>
        db.from("partner_agreements").select("venue_id,organization_id,terms").limit(500),
      );
      const venuesRes = agreementsRes.ok
        ? await probe<{ id: string; organization_id: string | null }>(() =>
            db.from("venues").select("id,organization_id").limit(2000),
          )
        : { ok: false as const, reason: agreementsRes.reason };
      if (!agreementsRes.ok || !venuesRes.ok) {
        const why = !agreementsRes.ok ? agreementsRes.reason : (venuesRes as { reason: string }).reason;
        checks[name] = { status: "skipped", reason: `agreement lookup failed: ${why}` };
      } else {
        const orgByVenue = new Map(venuesRes.rows.map((v) => [v.id, v.organization_id]));
        const pctByVenueAgreement = new Map<string, number>();
        const pctByOrg = new Map<string, number>();
        for (const a of agreementsRes.rows) {
          const pct = parseCommissionPct(a.terms);
          if (pct == null) continue;
          if (a.venue_id && !pctByVenueAgreement.has(a.venue_id)) pctByVenueAgreement.set(a.venue_id, pct);
          if (!a.venue_id && a.organization_id && !pctByOrg.has(a.organization_id)) pctByOrg.set(a.organization_id, pct);
        }
        const pctByVenue = new Map<string, number>();
        for (const l of ledgersRes.rows) {
          const direct = pctByVenueAgreement.get(l.venue_id);
          const orgPct = pctByOrg.get(orgByVenue.get(l.venue_id) ?? "");
          const pct = direct ?? orgPct;
          if (pct != null) pctByVenue.set(l.venue_id, pct);
        }
        const drifted = commissionDriftIds(ledgersRes.rows, pctByVenue);
        let n = 0;
        for (const id of drifted.slice(0, ALERT_SWEEP_ROW_CAP)) {
          emit(`finance.commission_drift ledger=${id} heuristic=latest_agreement_pct evidence=/admin/payouts`);
          n += 1;
          bump();
        }
        checks[name] = { status: "ok", matched: drifted.length, emitted: n };
      }
    }
  }

  /* ── ops.rental_decline — last-7d created rentals <50% of prior-7d, with a
     >=10 baseline so tiny volumes don't page. Two head counts; one stable
     alert (counts stay out of the message for fingerprint dedup). */
  {
    const name = "rental_decline";
    const w = RENTAL_DECLINE_WINDOW_DAYS * DAY;
    const recentCut = new Date(nowMs - w).toISOString();
    const priorCut = new Date(nowMs - 2 * w).toISOString();
    // head:true count queries don't return rows — probe them directly.
    const countCreated = async (gte: string, lt?: string): Promise<number | null> => {
      try {
        let q = db.from("rentals").select("id", { count: "exact", head: true }).gte("created_at", gte);
        if (lt) q = q.lt("created_at", lt);
        const { count, error } = await q;
        return error ? null : count;
      } catch {
        return null;
      }
    };
    const [recent7, prior7] = await Promise.all([countCreated(recentCut), countCreated(priorCut, recentCut)]);
    if (recent7 == null || prior7 == null) {
      checks[name] = { status: "skipped", reason: "count query failed" };
    } else {
        const hit = rentalDeclineHit(recent7, prior7);
        let n = 0;
        if (hit) {
          emit(`ops.rental_decline window_days=${RENTAL_DECLINE_WINDOW_DAYS} evidence=/admin/rentals`);
          n = 1;
          bump();
        }
        checks[name] = { status: "ok", matched: hit ? 1 : 0, emitted: n };
    }
  }

  /* ── ops.inventory_mismatch — occupied kiosk_slots' power_bank_id set vs
     non-retired power_banks reporting current_kiosk, per kiosk, beyond
     INVENTORY_MISMATCH_TOLERANCE. Two bounded full scans; one alert per
     kiosk id. */
  {
    const name = "inventory_mismatch";
    const [slotsRes, banksRes] = await Promise.all([
      probe<InventorySlotRow>(() =>
        db.from("kiosk_slots").select("kiosk_id,state,power_bank_id").limit(INVENTORY_SCAN_LIMIT),
      ),
      probe<InventoryBankRow>(() =>
        db.from("power_banks").select("id,current_kiosk,retired").limit(INVENTORY_SCAN_LIMIT),
      ),
    ]);
    if (!slotsRes.ok || !banksRes.ok) {
      const skipReason = !slotsRes.ok ? slotsRes.reason : !banksRes.ok ? banksRes.reason : "unknown";
      checks[name] = { status: "skipped", reason: skipReason };
    } else {
      const mismatched = inventoryMismatchKiosks(slotsRes.rows, banksRes.rows);
      let n = 0;
      for (const kioskId of mismatched.slice(0, ALERT_SWEEP_ROW_CAP)) {
        emit(`ops.inventory_mismatch kiosk=${kioskId} evidence=/admin/fleet`);
        n += 1;
        bump();
      }
      checks[name] = { status: "ok", matched: mismatched.length, emitted: n };
    }
  }

  return { ok: true, emitted, checks };
}

export { HEARTBEAT_STALE_MIN };
