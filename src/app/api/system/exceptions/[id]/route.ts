import { NextResponse } from "next/server";
import { systemApiGuard, readJson } from "../../_shared";
import {
  addExceptionNote, assignException, exceptionPatchSchema, getException,
  transitionException, isUuid,
} from "@/lib/system/exceptions";
import { roleCan } from "@/lib/system/rbac";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/exceptions/[id] — exception detail + assembled evidence
 * (device_events timeline, correlated device_command, rental state, kiosk
 * connectivity, audit history). Read perm: system.kiosks.view.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Invalid exception id" }, { status: 400 });

  const detail = await getException(g.db, id);
  if (!detail) return NextResponse.json({ error: "Exception not found" }, { status: 404 });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "exception.viewed",
    resource: `rental_exception:${id}`,
    detail: { kind: detail.exception.kind, state: detail.exception.state },
  });
  return NextResponse.json({ configured: true, ...detail });
}

/**
 * PATCH /api/system/exceptions/[id] — staff mutation.
 * Body is a discriminated union on `action`:
 *   { action:"transition", to_status, reason?, resolution_notes? }
 *   { action:"assign",      assigned_to: uuid|null }
 *   { action:"note",        text }
 *
 * Read perm system.kiosks.view + mutation perm system.kiosks.manage.
 * Illegal transitions → 409, missing reopen reason → 422, breakglass → 202
 * pending change request. Resolving never touches money — financial-review
 * kinds stay flagged (see lib/system/exceptions.ts).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 30 });
  if (!g.ok) return g.res;
  if (!roleCan(g.role, "system.kiosks.manage")) {
    return NextResponse.json({ error: "Missing permission: system.kiosks.manage (exception mutations)" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Invalid exception id" }, { status: 400 });

  const raw = await readJson(req);
  const parsed = exceptionPatchSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body — expected {action:'transition'|'assign'|'note', …}" }, { status: 422 });
  }

  const actor = { id: g.user.id, role: g.role };
  const body = parsed.data;
  const result =
    body.action === "transition"
      ? await transitionException(g.db, actor, id, body.to_status, { reason: body.reason, resolutionNotes: body.resolution_notes })
      : body.action === "assign"
        ? await assignException(g.db, actor, id, body.assigned_to)
        : await addExceptionNote(g.db, actor, id, body.text);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, reason: result.reason ?? null, allowed: result.allowed ?? null },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    exception: result.exception,
    changeRequestId: result.changeRequestId,
    ...(result.financialReviewRequired ? { financial_review_required: true } : {}),
  });
}
