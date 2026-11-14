import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { linkIncidentEvidence } from "@/lib/system/incidents";
import { roleCan } from "@/lib/system/rbac";

const linkSchema = z.object({
  type: z.enum(["error_issue", "deployment", "device", "change_request", "incident", "other"]),
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().max(200).optional(),
});

const bodySchema = z.object({
  links: z.array(linkSchema).min(1).max(20),
});

/**
 * POST /api/system/incidents/[id]/evidence — link evidence (error_issue /
 * deployment / device / change_request ids) onto the incident. Stored in
 * incidents.links jsonb (no single FK target exists), deduplicated on
 * type+id, capped at 50. Same permission model as other incident mutations.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.security.audit.view", { limit: 30 });
  if (!g.ok) return g.res;
  if (!roleCan(g.role, "system.changes.request")) {
    return NextResponse.json({ error: "Missing permission: system.changes.request (incident mutations)" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid incident id" }, { status: 400 });

  const raw = await readJson(req);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid body — expected { links: [{type,id,label?}] }" }, { status: 422 });

  const result = await linkIncidentEvidence(g.db, { id: g.user.id, role: g.role }, id, parsed.data.links);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, reason: result.reason },
      { status: result.status === 202 ? 202 : result.status },
    );
  }
  return NextResponse.json({ ok: true, incident: result.incident, changeRequestId: result.changeRequestId });
}
