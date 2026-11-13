import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { isUuid } from "@/lib/system/kiosks";
import {
  MAINTENANCE_STATUSES, MAINTENANCE_VISIT_SELECT, canTransitionVisit,
  visitTransitionPatch, type MaintenanceStatus,
} from "@/lib/system/device-config";
import { systemAudit } from "@/lib/system/audit";
import { deviceAuditResource } from "@/lib/system/kiosks";

const patchSchema = z.object({
  status: z.enum(MAINTENANCE_STATUSES),
  technician: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

/**
 * PATCH /api/system/kiosks/maintenance/[id] — status transition + field edits.
 * Permission: system.kiosks.manage. Workflow: open→scheduled→in_progress→
 * completed, any non-terminal→cancelled (see MAINTENANCE_TRANSITIONS).
 * Illegal edges → 409. Audited.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 60 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Visit not found" }, { status: 404 });

  const { data: existing, error: readErr } = await g.db.from("system_maintenance_visits")
    .select(MAINTENANCE_VISIT_SELECT).eq("id", id).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  const visit = existing as { id: string; device_id: string; status: MaintenanceStatus };

  const body = await readJson(req);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues, statuses: MAINTENANCE_STATUSES }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const d = parsed.data;
  if (d.technician !== undefined) patch.technician = d.technician;
  if (d.notes !== undefined) patch.notes = d.notes;
  if (d.scheduled_at !== undefined) patch.scheduled_at = d.scheduled_at;

  if (d.status !== visit.status) {
    if (!canTransitionVisit(visit.status, d.status)) {
      return NextResponse.json(
        { error: `Illegal transition ${visit.status} → ${d.status}`, allowed: visit.status },
        { status: 409 },
      );
    }
    Object.assign(patch, visitTransitionPatch(d.status));
  }

  const { data: updated, error } = await g.db.from("system_maintenance_visits")
    .update(patch).eq("id", id).select(MAINTENANCE_VISIT_SELECT).single();
  if (error || !updated) return NextResponse.json({ error: error?.message ?? "update failed" }, { status: 500 });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "kiosk.maintenance_transition",
    resource: deviceAuditResource(visit.device_id),
    detail: { visit_id: id, from: visit.status, to: d.status },
  });
  return NextResponse.json({ visit: updated });
}
