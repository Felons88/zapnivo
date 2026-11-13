import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { getSystemDevice } from "@/lib/system/kiosks";
import {
  CONFIG_KEYS, approveConfig, dispatchConfig, listConfigRevisions,
  proposeConfig, proposeRollback,
} from "@/lib/system/device-config";

const postSchema = z.object({
  action: z.enum(["propose", "approve", "dispatch", "rollback"]),
  desired: z.record(z.string(), z.unknown()).optional(),
  revision_id: z.string().uuid().optional(),
  justification: z.string().trim().max(500).optional(),
}).strict();

/**
 * GET /api/system/kiosks/[id]/config — desired-state config revision history.
 * Permission: system.kiosks.view. Read-only.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  const revisions = await listConfigRevisions(g.db, device.id);
  return NextResponse.json({ revisions, allowed_keys: CONFIG_KEYS });
}

/**
 * POST /api/system/kiosks/[id]/config — desired-state config operations.
 * Permission: system.kiosks.manage.
 *
 *   propose  { desired }            → draft revision (whitelist-validated)
 *   approve  { revision_id }        → draft→approved (change-request gate by risk)
 *   dispatch { revision_id }        → approved→command row; adapter=none records
 *                                     state='failed'/adapter_disabled honestly
 *   rollback {}                     → new draft restoring the previously applied desired
 *
 * 202 + changeRequestId when approval is pending. Audited per action.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const body = await readJson(req);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues, allowed_keys: CONFIG_KEYS }, { status: 400 });
  }
  const actor = { id: g.user.id, role: g.role };
  const d = parsed.data;

  switch (d.action) {
    case "propose": {
      if (d.desired === undefined) return NextResponse.json({ error: "desired is required" }, { status: 400 });
      const r = await proposeConfig(g.db, device, d.desired, actor);
      if (!r.ok) return NextResponse.json({ error: r.error, ...(r.pending ? { pending: true, changeRequestId: r.changeRequestId } : {}) }, { status: r.status });
      return NextResponse.json({ revision: r.revision }, { status: 201 });
    }
    case "approve": {
      if (!d.revision_id) return NextResponse.json({ error: "revision_id is required" }, { status: 400 });
      const r = await approveConfig(g.db, device, d.revision_id, actor, d.justification);
      if (!r.ok) return NextResponse.json({ error: r.error, ...(r.pending ? { pending: true, changeRequestId: r.changeRequestId } : {}) }, { status: r.status });
      return NextResponse.json({ revision: r.revision });
    }
    case "dispatch": {
      if (!d.revision_id) return NextResponse.json({ error: "revision_id is required" }, { status: 400 });
      const r = await dispatchConfig(g.db, device, d.revision_id, actor);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ revision: r.revision, command: r.command, dispatched: r.dispatched });
    }
    case "rollback": {
      const r = await proposeRollback(g.db, device, actor);
      if (!r.ok) return NextResponse.json({ error: r.error, ...(r.pending ? { pending: true, changeRequestId: r.changeRequestId } : {}) }, { status: r.status });
      return NextResponse.json({ revision: r.revision }, { status: 201 });
    }
  }
}
