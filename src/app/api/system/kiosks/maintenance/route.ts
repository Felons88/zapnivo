import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { getSystemDevice } from "@/lib/system/kiosks";
import {
  MAINTENANCE_VISIT_TYPES, listMaintenanceVisits,
} from "@/lib/system/device-config";
import { systemAudit } from "@/lib/system/audit";
import { deviceAuditResource } from "@/lib/system/kiosks";

const createSchema = z.object({
  device_id: z.string().uuid(),
  visit_type: z.enum(MAINTENANCE_VISIT_TYPES).default("routine"),
  scheduled_at: z.string().datetime({ offset: true }).optional(),
  technician: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
}).strict();

/**
 * GET /api/system/kiosks/maintenance — list system_maintenance_visits.
 * Query: ?status=… &device_id=…&limit=…  Permission: system.kiosks.view.
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const url = new URL(req.url);
  const visits = await listMaintenanceVisits(g.db, {
    status: url.searchParams.get("status") ?? undefined,
    deviceId: url.searchParams.get("device_id") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 200) || 200,
  });
  return NextResponse.json({ visits });
}

/**
 * POST /api/system/kiosks/maintenance — schedule a maintenance visit.
 * Permission: system.kiosks.manage. Creates status 'open' (or 'scheduled'
 * when scheduled_at is provided). Audited.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues, visit_types: MAINTENANCE_VISIT_TYPES }, { status: 400 });
  }
  const device = await getSystemDevice(g.db, parsed.data.device_id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const actor = { id: g.user.id, role: g.role };
  const { data, error } = await g.db.from("system_maintenance_visits").insert({
    device_id: device.id,
    visit_type: parsed.data.visit_type,
    status: parsed.data.scheduled_at ? "scheduled" : "open",
    scheduled_at: parsed.data.scheduled_at ?? null,
    technician: parsed.data.technician ?? null,
    notes: parsed.data.notes ?? null,
    created_by: g.user.id,
  }).select("id,device_id,visit_type,status,scheduled_at,started_at,completed_at,technician,notes,created_by,created_at,updated_at").single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  await systemAudit(g.db, {
    actor, action: "kiosk.maintenance_scheduled", resource: deviceAuditResource(device.id),
    detail: { visit_id: (data as { id: string }).id, visit_type: parsed.data.visit_type, scheduled_at: parsed.data.scheduled_at ?? null },
  });
  return NextResponse.json({ visit: data }, { status: 201 });
}

/* Status transitions: PATCH /api/system/kiosks/maintenance/[id] */
