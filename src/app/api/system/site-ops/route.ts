import { NextResponse } from "next/server";
import { systemApiGuard, readJson } from "../_shared";
import { executeEmergencyOp, getMaintenanceNotice } from "@/lib/system/emergency";
import {
  createRedirect, deleteRedirect, listRedirects, siteOpsSummary, updateRedirect,
} from "@/lib/system/site-ops";

/**
 * /api/system/site-ops — website ops controls.
 *
 * GET  — maintenance notice state + redirect rules + per-site ops summary
 *        (system.dashboard.view).
 * POST — mutations (system.flags.manage — site ops are flag/config backed;
 *        breakglass additionally needs an approved change request via
 *        assertApprovedOrRequest inside each op):
 *          set_notice / clear_notice → delegated to the emergency
 *            maintenance_banner op (step-up elevation + audit preserved).
 *          create_redirect / update_redirect / delete_redirect → site_redirects
 *            CRUD with same-host redirect target validation.
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const [notice, redirects, summary] = await Promise.all([
    getMaintenanceNotice(g.db),
    listRedirects(g.db),
    siteOpsSummary(g.db),
  ]);
  return NextResponse.json({ notice, redirects, summary });
}

const idRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const g = await systemApiGuard("system.flags.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const action = typeof body.action === "string" ? body.action : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10 || reason.length > 2000) {
    return NextResponse.json({ error: "reason must be 10–2000 characters" }, { status: 400 });
  }
  const actor = { id: g.user.id, role: g.role };

  let result: { ok: boolean; status?: number; error?: string; summary?: string; pending?: boolean; changeRequestId?: string | null; expiresAt?: string | null };

  switch (action) {
    case "set_notice":
    case "clear_notice": {
      // Delegate to the emergency op — keeps elevation + change-request + audit contract identical.
      const severity = body.severity === "warning" || body.severity === "critical" ? body.severity : "info";
      const minutes = typeof body.minutes === "number" && Number.isInteger(body.minutes) ? body.minutes : undefined;
      const r = await executeEmergencyOp(g.db, g.user, actor, {
        op: "maintenance_banner",
        confirm: "maintenance_banner",
        reason,
        banner_enabled: action === "set_notice",
        banner_message: typeof body.message === "string" ? body.message : undefined,
        banner_minutes: minutes,
        banner_severity: severity,
      });
      result = r.ok
        ? { ok: true, summary: r.summary, expiresAt: r.expiresAt, changeRequestId: r.changeRequestId }
        : { ok: false, status: r.status, error: r.error, pending: r.pending, changeRequestId: r.changeRequestId };
      break;
    }
    case "create_redirect": {
      const r = await createRedirect(g.db, g.user, actor, {
        site_key: body.site_key,
        from_path: body.from_path,
        to_path: body.to_path,
        enabled: body.enabled,
        note: body.note,
      }, reason);
      result = r.ok ? { ok: true, summary: r.summary } : { ok: false, status: r.status, error: r.error, pending: r.pending, changeRequestId: r.changeRequestId };
      break;
    }
    case "update_redirect": {
      const id = typeof body.id === "string" ? body.id : "";
      if (!idRe.test(id)) return NextResponse.json({ error: "Invalid redirect id" }, { status: 400 });
      const r = await updateRedirect(g.db, g.user, actor, id, {
        to_path: body.to_path,
        enabled: body.enabled,
        note: body.note,
      }, reason);
      result = r.ok ? { ok: true, summary: r.summary } : { ok: false, status: r.status, error: r.error, pending: r.pending, changeRequestId: r.changeRequestId };
      break;
    }
    case "delete_redirect": {
      const id = typeof body.id === "string" ? body.id : "";
      if (!idRe.test(id)) return NextResponse.json({ error: "Invalid redirect id" }, { status: 400 });
      const r = await deleteRedirect(g.db, g.user, actor, id, reason);
      result = r.ok ? { ok: true, summary: r.summary } : { ok: false, status: r.status, error: r.error, pending: r.pending, changeRequestId: r.changeRequestId };
      break;
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.pending ? { status: "pending", pending: true } : {}),
        ...(result.changeRequestId ? { changeRequestId: result.changeRequestId } : {}),
      },
      { status: result.status ?? 500 },
    );
  }
  return NextResponse.json({ ok: true, summary: result.summary ?? "done", expiresAt: result.expiresAt ?? null });
}
