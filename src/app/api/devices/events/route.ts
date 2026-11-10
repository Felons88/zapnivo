import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { serviceClient } from "@/lib/supabase";
import { ingestBodySchema, ingestKioskEvents } from "@/lib/kiosk/ingest";

/**
 * Hardware event ingest — vendor-agnostic. A kiosk gateway (or vendor webhook bridge) POSTs
 * batches here with `Authorization: Bearer $KIOSK_INGEST_SECRET`. Events are appended to the
 * immutable device_events log, projected into kiosk_slots / power_banks / kiosks.last_seen_at,
 * and actionable events (docks, heartbeats) run through the rental lifecycle processor.
 */
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function POST(req: Request) {
  const secret = process.env.KIOSK_INGEST_SECRET;
  if (!secret) return NextResponse.json({ error: "Device ingest not configured" }, { status: 503 });
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEq(bearer, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const parsed = ingestBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 422 });
  const body = parsed.data;

  const { data: kiosk } = await db.from("kiosks").select("id,state").eq("station_id", body.station_id).single();
  if (!kiosk) return NextResponse.json({ error: "Unknown station" }, { status: 404 });

  const result = await ingestKioskEvents(db, kiosk as { id: string; state?: string }, body);
  return NextResponse.json({ ok: true, ...result });
}
