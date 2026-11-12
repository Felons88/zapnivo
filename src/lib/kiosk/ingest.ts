import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { processKioskEvent, type KioskEventDeps, type KioskEventOutcome } from "./lifecycle";
import { normalizeCapabilityName, requiredCapabilityFor } from "./capabilities";
import { recordLog, reportError } from "../observability";

/**
 * Shared ingest pipeline for authenticated kiosk event batches. The HTTP route and the
 * simulator/tests both call ingestKioskEvents — serial→bank resolution, the immutable
 * device_events log, slot projection, kiosk liveness, and rental lifecycle processing.
 */
const eventSchema = z.object({
  event_id: z.string().trim().min(1).max(120).optional(),
  type: z.string().trim().min(1).max(60),
  slot: z.number().int().min(1).max(64).optional(),
  slot_state: z.enum(["empty", "charging", "ready", "fault"]).optional(),
  power_bank_serial: z.string().trim().min(1).max(60).optional(),
  battery_pct: z.number().int().min(0).max(100).optional(),
  at: z.string().datetime().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  // ── Phase 2.4: normalized hardware acknowledgement fields (all optional —
  //    legacy clients that send none keep working unchanged). ──────────────
  /** Correlates to device_commands.id OR device_commands.idempotency_key. */
  command_id: z.string().trim().min(1).max(120).optional(),
  /** Rental UUID or public reference (e.g. "ZR-XXXXXXXX") the ack belongs to. */
  rental_ref: z.string().trim().min(1).max(80).optional(),
  /** Device-reported ack classification. */
  outcome: z.enum(["acknowledged", "failed", "rejected", "detected", "released"]).optional(),
  /** Short vendor-normalized failure code (e.g. "motor_stall", "slot_busy"). */
  error_code: z.string().trim().min(1).max(60).optional(),
  /** Device hardware clock timestamp for THIS event (ISO-8601). `at` remains the
   *  batch-level device-reported time; hw_timestamp is the per-event hardware time. */
  hw_timestamp: z.string().datetime().optional(),
  /** Marks synthetic/test-originated events so stored telemetry stays honest —
   *  a simulated ack must never be mistaken for hardware confirmation. */
  simulated: z.boolean().optional(),
});
export const ingestBodySchema = z.object({
  station_id: z.string().trim().min(1).max(40),
  firmware_version: z.string().trim().max(40).optional(),
  events: z.array(eventSchema).min(1).max(200),
});
export type IngestBody = z.infer<typeof ingestBodySchema>;

/**
 * Event types the platform recognizes explicitly. `type` stays a free-form string on
 * the wire (vendor aliases land as "ignored" unless listed here or in lifecycle's
 * RETURN_EVENT_TYPES). The ack types below carry command/rental correlation.
 */
export const KNOWN_EVENT_TYPES = new Set([
  // baseline telemetry
  "heartbeat", "slot_state",
  // physical returns (verified path — see lifecycle.RETURN_EVENT_TYPES)
  "power_bank_docked", "bank_returned", "return_detected", "return_acknowledged",
  // command acknowledgements & failures (Phase 2.4)
  "dispense_requested", "dispense_acknowledged", "dispense_failed",
  "bank_released", "return_rejected", "hardware_fault",
]);

/**
 * Phase 2.5 — an event denied by server-side capability enforcement. Denied
 * events NEVER reach processKioskEvent (no kiosk_events claim, no slot/bank
 * projection, no rental effect); they are recorded only in the immutable
 * device_events log with payload.denied_reason='capability_denied' plus a
 * warning-level observability signal. `outcomes`/`KioskEventOutcome` are owned
 * by lifecycle.ts, so denials travel in this parallel list instead.
 */
export type DeniedKioskEvent = {
  /** Index into body.events. */
  index: number;
  event_id: string | null;
  type: string;
  required_capability: string;
};

export type IngestResult = {
  /** Events that entered the lifecycle pipeline (denied events excluded). */
  accepted: number;
  outcomes: KioskEventOutcome[];
  denied: DeniedKioskEvent[];
};

/**
 * @param capabilities Phase 2.5 enforcement input — the RESOLVED capability set
 *   from stored device records (see capabilities.ts), passed by the HTTP route.
 *   Semantics: `undefined` → enforcement OFF (internal callers: simulator/tests
 *   keep legacy behavior); `null`/empty set → enforced, baseline-only
 *   (fail-closed). Names are normalized, so raw or canonical spellings both work.
 *   Event payloads are never consulted — self-reported `capabilities`/`caps`
 *   fields in the body cannot escalate privileges.
 */
export async function ingestKioskEvents(
  db: SupabaseClient,
  kiosk: { id: string; state?: string },
  body: IngestBody,
  now = new Date(),
  deps: KioskEventDeps = {},
  capabilities?: ReadonlySet<string> | readonly string[] | null,
): Promise<IngestResult> {
  const outcomes: KioskEventOutcome[] = [];
  const denied: DeniedKioskEvent[] = [];
  const enforce = capabilities !== undefined;
  const capSet = enforce
    ? new Set<string>((capabilities == null ? [] : [...capabilities]).map(normalizeCapabilityName))
    : null;

  for (const [index, e] of body.events.entries()) {
    // Capability gate FIRST — a denied event must not upsert power_banks,
    // claim a kiosk_events row, project slots, or touch rentals.
    if (capSet) {
      const required = requiredCapabilityFor(e.type);
      if (required && !capSet.has(required)) {
        denied.push({ index, event_id: e.event_id ?? null, type: e.type, required_capability: required });
        await db.from("device_events").insert({
          kiosk_id: kiosk.id, slot_number: e.slot ?? null, event_type: e.type,
          payload: {
            denied_reason: "capability_denied",
            required_capability: required,
            ...(e.event_id ? { event_id: e.event_id } : {}),
            ...(e.simulated != null ? { simulated: e.simulated } : {}),
          },
          occurred_at: e.at ?? e.hw_timestamp ?? now.toISOString(),
        });
        continue;
      }
    }
    let bankId: string | null = null;
    if (e.power_bank_serial) {
      const { data: bank } = await db.from("power_banks")
        .upsert({ serial: e.power_bank_serial, ...(e.battery_pct != null ? { battery_pct: e.battery_pct } : {}), current_kiosk: kiosk.id }, { onConflict: "serial" })
        .select("id").single();
      bankId = bank?.id ?? null;
    }
    // Single merged payload: ack correlation fields + slot/bank context are stored
    // verbatim on BOTH the kiosk_events ledger row and the immutable device_events log.
    const mergedPayload: Record<string, unknown> = {
      ...(e.payload ?? {}),
      ...(e.slot != null ? { slot: e.slot } : {}),
      ...(e.slot_state ? { slot_state: e.slot_state } : {}),
      ...(e.power_bank_serial ? { power_bank_serial: e.power_bank_serial } : {}),
      ...(e.command_id ? { command_id: e.command_id } : {}),
      ...(e.rental_ref ? { rental_ref: e.rental_ref } : {}),
      ...(e.outcome ? { outcome: e.outcome } : {}),
      ...(e.error_code ? { error_code: e.error_code } : {}),
      ...(e.hw_timestamp ? { hw_timestamp: e.hw_timestamp } : {}),
      ...(e.simulated != null ? { simulated: e.simulated } : {}),
    };
    // Lifecycle first: kiosk_events.event_id is the dedupe claim, so a replayed event is
    // detected here and skips the raw log, slot projection and rental processing entirely.
    // Ack events always claim a ledger row (even without event_id) so their result is recorded.
    const outcome = await processKioskEvent(db, kiosk, {
      eventId: e.event_id ?? null,
      type: e.type,
      powerBankId: bankId,
      commandId: e.command_id ?? null,
      rentalRef: e.rental_ref ?? null,
      ackOutcome: e.outcome ?? null,
      errorCode: e.error_code ?? null,
      hwTimestamp: e.hw_timestamp ?? null,
      simulated: e.simulated ?? null,
      deviceAt: e.at ?? e.hw_timestamp ?? null,
      occurredAt: e.hw_timestamp ?? e.at ?? now.toISOString(),
      payload: mergedPayload,
    }, now, deps);
    outcomes.push(outcome);
    if (outcome.result === "duplicate") continue;

    await db.from("device_events").insert({ kiosk_id: kiosk.id, slot_number: e.slot ?? null, power_bank_id: bankId, event_type: e.type, payload: mergedPayload, occurred_at: e.at ?? e.hw_timestamp ?? now.toISOString() });
    if (e.slot && e.slot_state) {
      await db.from("kiosk_slots").upsert({ kiosk_id: kiosk.id, slot_number: e.slot, state: e.slot_state, power_bank_id: e.slot_state === "empty" ? null : bankId }, { onConflict: "kiosk_id,slot_number" });
    }
  }

  // A heartbeat from a disabled/maintenance kiosk must not silently re-enable it.
  const next: Record<string, unknown> = { last_seen_at: now.toISOString(), ...(body.firmware_version ? { firmware_version: body.firmware_version } : {}) };
  if (kiosk.state === "offline" || kiosk.state === "provisioning") { next.state = "online"; next.offline_alerted_at = null; if (kiosk.state === "provisioning") next.installed_at = now.toISOString(); }
  await db.from("kiosks").update(next).eq("id", kiosk.id);

  // Security signal: capability-denied events are already in device_events;
  // surface a batch-level warning so repeated attempts are visible in
  // app_logs + the grouped error_issues feed. Fail-open, no secrets.
  if (denied.length) {
    const summary = denied
      .map((d) => `${d.type}${d.required_capability ? `:${d.required_capability}` : ""}`)
      .slice(0, 10).join(",");
    recordLog("warning", "kiosk.ingest_capability_denied", {
      service: "kiosk-ingest", route: "/api/devices/events",
      attrs: { kiosk_id: kiosk.id, station_id: body.station_id, denied: denied.length, events: summary },
    });
    reportError(new Error(`Kiosk ingest denied ${denied.length} event(s) by capability policy (${summary})`), {
      route: "/api/devices/events", severity: "warning",
      attrs: { kiosk_id: kiosk.id, station_id: body.station_id },
    });
  }

  return { accepted: body.events.length - denied.length, outcomes, denied };
}
