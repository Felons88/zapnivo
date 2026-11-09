import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";

/**
 * Hardware event ingest — vendor-agnostic. A kiosk gateway (or vendor webhook bridge) POSTs
 * batches here with `Authorization: Bearer $KIOSK_INGEST_SECRET`. Events are appended to the
 * immutable device_events log and projected into kiosk_slots / power_banks / kiosks.last_seen_at.
 */
const eventSchema = z.object({
  type: z.string().trim().min(1).max(60),
  slot: z.number().int().min(1).max(64).optional(),
  slot_state: z.enum(["empty", "charging", "ready", "fault"]).optional(),
  power_bank_serial: z.string().trim().min(1).max(60).optional(),
  battery_pct: z.number().int().min(0).max(100).optional(),
  at: z.string().datetime().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
const bodySchema = z.object({ station_id: z.string().trim().min(1).max(40), firmware_version: z.string().trim().max(40).optional(), events: z.array(eventSchema).min(1).max(200) });

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function POST(req: Request) {
  const secret = process.env.KIOSK_INGEST_SECRET;
  if (!secret) return NextResponse.json({ error: "Device ingest not configured" }, { status: 503 });
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEq(bearer, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 422 });
  const { station_id, firmware_version, events } = parsed.data;

  const { data: kiosk } = await db.from("kiosks").select("id,state").eq("station_id", station_id).single();
  if (!kiosk) return NextResponse.json({ error: "Unknown station" }, { status: 404 });

  for (const e of events) {
    let bankId: string | null = null;
    if (e.power_bank_serial) {
      const { data: bank } = await db.from("power_banks")
        .upsert({ serial: e.power_bank_serial, ...(e.battery_pct != null ? { battery_pct: e.battery_pct } : {}), current_kiosk: kiosk.id }, { onConflict: "serial" })
        .select("id").single();
      bankId = bank?.id ?? null;
    }
    await db.from("device_events").insert({ kiosk_id: kiosk.id, slot_number: e.slot ?? null, power_bank_id: bankId, event_type: e.type, payload: e.payload ?? null, occurred_at: e.at ?? new Date().toISOString() });
    if (e.slot && e.slot_state) {
      await db.from("kiosk_slots").upsert({ kiosk_id: kiosk.id, slot_number: e.slot, state: e.slot_state, power_bank_id: e.slot_state === "empty" ? null : bankId }, { onConflict: "kiosk_id,slot_number" });
    }
  }

  // A heartbeat from a disabled/maintenance kiosk must not silently re-enable it.
  const next: Record<string, unknown> = { last_seen_at: new Date().toISOString(), ...(firmware_version ? { firmware_version } : {}) };
  if (kiosk.state === "offline" || kiosk.state === "provisioning") { next.state = "online"; next.offline_alerted_at = null; if (kiosk.state === "provisioning") next.installed_at = new Date().toISOString(); }
  await db.from("kiosks").update(next).eq("id", kiosk.id);
  return NextResponse.json({ ok: true, accepted: events.length });
}
