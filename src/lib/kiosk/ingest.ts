import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { processKioskEvent, type KioskEventDeps, type KioskEventOutcome } from "./lifecycle";

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

export async function ingestKioskEvents(
  db: SupabaseClient,
  kiosk: { id: string; state?: string },
  body: IngestBody,
  now = new Date(),
  deps: KioskEventDeps = {},
): Promise<{ accepted: number; outcomes: KioskEventOutcome[] }> {
  const outcomes: KioskEventOutcome[] = [];

  for (const e of body.events) {
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

  return { accepted: body.events.length, outcomes };
}
