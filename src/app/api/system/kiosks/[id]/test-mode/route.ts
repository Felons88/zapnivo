import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { getSystemDevice } from "@/lib/system/kiosks";
import { kiosksForSystemDevice } from "@/lib/system/command-ops";
import { systemAudit } from "@/lib/system/audit";

const bodySchema = z.object({ enabled: z.boolean() });

/**
 * POST /api/system/kiosks/[id]/test-mode — toggle per-kiosk test mode.
 * Permission: system.kiosks.manage. Applies to every rental-facing kiosk bound
 * to this device (station_id ↔ device_uid/serial_number). Test mode relaxes the
 * live-availability gates (online state, installed_at, published venue, ready
 * banks) for station lookup and checkout so staff can exercise the customer
 * flow pre-launch. It NEVER bypasses payment — Stripe checkout still runs.
 * Audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const body = await readJson(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Body must be { enabled: boolean }" }, { status: 400 });

  const bound = await kiosksForSystemDevice(g.db, device);
  if (bound.length === 0) {
    return NextResponse.json({ error: "No rental-facing kiosk is bound to this device — create an app station first." }, { status: 409 });
  }

  const { error } = await g.db.from("kiosks").update({ test_mode: parsed.data.enabled }).in("id", bound.map((k) => k.id));
  if (error) return NextResponse.json({ error: "Could not update kiosk test mode." }, { status: 500 });

  const stations = bound.map((k) => k.station_id).filter((s): s is string => Boolean(s));
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: parsed.data.enabled ? "kiosk.test_mode.enabled" : "kiosk.test_mode.disabled",
    resource: `device:${device.id}`,
    detail: { device_uid: device.device_uid, station_ids: stations },
  });
  return NextResponse.json({ test_mode: parsed.data.enabled, station_ids: stations });
}
