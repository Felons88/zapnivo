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
});
export const ingestBodySchema = z.object({
  station_id: z.string().trim().min(1).max(40),
  firmware_version: z.string().trim().max(40).optional(),
  events: z.array(eventSchema).min(1).max(200),
});
export type IngestBody = z.infer<typeof ingestBodySchema>;

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
    // Lifecycle first: kiosk_events.event_id is the dedupe claim, so a replayed event is
    // detected here and skips the raw log, slot projection and rental processing entirely.
    const outcome = await processKioskEvent(db, kiosk, {
      eventId: e.event_id ?? null,
      type: e.type,
      powerBankId: bankId,
      deviceAt: e.at ?? null,
      occurredAt: e.at ?? now.toISOString(),
      payload: {
        ...(e.payload ?? {}),
        ...(e.slot != null ? { slot: e.slot } : {}),
        ...(e.slot_state ? { slot_state: e.slot_state } : {}),
        ...(e.power_bank_serial ? { power_bank_serial: e.power_bank_serial } : {}),
      },
    }, now, deps);
    outcomes.push(outcome);
    if (outcome.result === "duplicate") continue;

    await db.from("device_events").insert({ kiosk_id: kiosk.id, slot_number: e.slot ?? null, power_bank_id: bankId, event_type: e.type, payload: e.payload ?? null, occurred_at: e.at ?? now.toISOString() });
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
