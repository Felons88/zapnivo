import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { systemAudit } from "@/lib/system/audit";
import { deviceAuditResource, getSystemDevice, isUuid } from "@/lib/system/kiosks";
import { computeOnboardingEvidence } from "./evidence";

/**
 * /api/system/kiosks/onboarding — first-kiosk onboarding wizard backend.
 *
 * GET  ?device_id=<uuid> — per-step evidence aggregator (13 steps). Read-only;
 *      permission system.kiosks.view. Every step state is computed from real
 *      stored rows (timestamps, command rows, certification runs, bound-kiosk
 *      telemetry) — nothing is fabricated; hardware-dependent steps report
 *      'awaiting_hardware'.
 *
 * POST { action: "assign_venue", device_id, venue_id } — sets
 *      system_devices.venue_id (venue_id null clears). venue_id is settable at
 *      registration but had NO update endpoint; this is the minimal mutation
 *      the wizard needs. Permission system.kiosks.manage; venue existence is
 *      verified; audited as kiosk.venue_assigned.
 *
 * All other wizard mutations intentionally reuse existing endpoints:
 *   register  → POST /api/system/kiosks/register
 *   token     → POST /api/system/kiosks/[id]/provision (+ /revoke)
 *   redeem    → POST /api/devices/provision   (performed BY the device/gateway)
 *   diagnostics → POST /api/system/kiosks/[id]/diagnostics
 *   suite     → POST /api/system/kiosks/certification {action:'run_suite'}
 *   activate  → POST /api/system/kiosks/[id]/status {status:'active'}
 */

const assignVenueSchema = z.object({
  action: z.literal("assign_venue"),
  device_id: z.string().uuid(),
  venue_id: z.string().uuid().nullable(),
});

export async function GET(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;

  const deviceId = new URL(req.url).searchParams.get("device_id");
  if (!deviceId || !isUuid(deviceId)) {
    return NextResponse.json({ error: "device_id query param (uuid) is required" }, { status: 400 });
  }
  const device = await getSystemDevice(g.db, deviceId);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const evidence = await computeOnboardingEvidence(g.db, device);
  return NextResponse.json(evidence);
}

export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = assignVenueSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Unsupported action — only { action: 'assign_venue', device_id, venue_id } is handled here", issues: parsed.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }
  const { device_id: deviceId, venue_id: venueId } = parsed.data;

  const device = await getSystemDevice(g.db, deviceId);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  if (venueId) {
    const { data: venue } = await g.db.from("venues").select("id").eq("id", venueId).maybeSingle();
    if (!venue) return NextResponse.json({ error: "venue_id does not match a known venue" }, { status: 400 });
  }

  const { data, error } = await g.db.from("system_devices")
    .update({ venue_id: venueId, updated_at: new Date().toISOString() })
    .eq("id", device.id)
    .select("id,venue_id")
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "update failed" }, { status: 500 });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "kiosk.venue_assigned",
    resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, venue_id: venueId, previous_venue_id: device.venue_id },
  });

  return NextResponse.json({ device: data });
}
