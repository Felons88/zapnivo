import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { addIncidentNote } from "@/lib/system/incidents";
import { roleCan } from "@/lib/system/rbac";

const bodySchema = z.object({
  note: z.string().trim().min(3).max(2000),
});

/**
 * POST /api/system/incidents/[id]/notes — append an investigation note.
 * Stored as an append-only system_audit_events row (action 'incident.note')
 * so it appears in the incident timeline. Same permission model as the other
 * incident mutations (audit.view + changes.request; breakglass → change req).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.security.audit.view", { limit: 60 });
  if (!g.ok) return g.res;
  if (!roleCan(g.role, "system.changes.request")) {
    return NextResponse.json({ error: "Missing permission: system.changes.request (incident mutations)" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid incident id" }, { status: 400 });

  const raw = await readJson(req);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid body — expected { note } (3–2000 chars)" }, { status: 422 });

  const result = await addIncidentNote(g.db, { id: g.user.id, role: g.role }, id, parsed.data.note);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, reason: result.reason },
      { status: result.status === 202 ? 202 : result.status },
    );
  }
  return NextResponse.json({ ok: true, incident: result.incident, changeRequestId: result.changeRequestId });
}
