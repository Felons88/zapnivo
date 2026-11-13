import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/observability";
import { heartbeatStale, HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";

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
 * Every probe is fault-tolerant: a missing table/column or query error marks
 * that check 'skipped' — the sweep NEVER throws and never crashes the cron.
 * Emissions go through reportError → error_events/error_issues, fingerprinted
 * per entity (stable message = one grouped issue per exception/command/
 * rental/device). Messages carry ids + coarse codes only — no PII, no secrets.
 */

export const EXCEPTION_STALE_HOURS = 24;
export const SETTLEMENT_STALE_HOURS = 24;
export const COMMAND_STUCK_MINUTES = 10;
/** Max rows inspected/emitted per check — bounds cron runtime and alert volume. */
export const ALERT_SWEEP_ROW_CAP = 25;
/** Device scan is wider (need the full enrolled fleet to find stale ones). */
const DEVICE_SCAN_LIMIT = 200;

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

  return { ok: true, emitted, checks };
}

export { HEARTBEAT_STALE_MIN };
