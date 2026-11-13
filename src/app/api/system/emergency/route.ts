import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../_shared";
import {
  EMERGENCY_PAUSABLE_FLAGS,
  executeEmergencyOp,
  listEmergencyActions,
} from "@/lib/system/emergency";

/**
 * /api/system/emergency — SCOPED emergency controls.
 *
 * GET  — recent executed emergency ops from system_audit_events
 *        (system.emergency.view — every system role).
 * POST — execute ONE typed emergency op (system.emergency.execute —
 *        security/sysadmin/breakglass). system.emergency.request/.approve are
 *        reserved for the future dedicated two-person flow; today SoD is
 *        enforced inside executeEmergencyOp via the change-request gate
 *        (assertApprovedOrRequest requires decided_by ≠ requested_by, and
 *        breakglass always needs an approved request). Every op additionally
 *        requires a live step-up elevation.
 *
 * There is intentionally NO bulk / "disable everything" endpoint — each op
 * names exactly one target (device, flag, agent, or the maintenance banner).
 */

/** GET /api/system/emergency — recent emergency actions (system.emergency.view). */
export async function GET() {
  const g = await systemApiGuard("system.emergency.view", { limit: 120 });
  if (!g.ok) return g.res;
  const actions = await listEmergencyActions(g.db, 50);
  return NextResponse.json({ actions });
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAG_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;

const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("suspend_device_credential"),
    confirm: z.string(),
    reason: z.string().trim().min(10).max(2000),
    device_id: z.string().regex(UUID_RE),
  }),
  z.object({
    op: z.literal("quarantine_device"),
    confirm: z.string(),
    reason: z.string().trim().min(10).max(2000),
    device_id: z.string().regex(UUID_RE),
  }),
  z.object({
    op: z.literal("pause_integration_feature"),
    confirm: z.string(),
    reason: z.string().trim().min(10).max(2000),
    flag: z.string().regex(FLAG_KEY_RE),
  }),
  z.object({
    op: z.literal("disable_ai_agent"),
    confirm: z.string(),
    reason: z.string().trim().min(10).max(2000),
    agent_id: z.string().regex(AGENT_ID_RE),
  }),
  z.object({
    op: z.literal("maintenance_banner"),
    confirm: z.string(),
    reason: z.string().trim().min(10).max(2000),
    banner_enabled: z.boolean(),
    banner_message: z.string().trim().max(280).optional(),
    banner_minutes: z.number().int().min(1).max(480).optional(),
    banner_severity: z.enum(["info", "warning", "critical"]).optional(),
  }),
]);

/**
 * POST /api/system/emergency — execute one scoped emergency op.
 * Gates (in order): system.emergency.execute → zod → executeEmergencyOp
 * (confirm check → step-up elevation → change-request gate → mutation+audit).
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.emergency.execute", { limit: 20 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const parsed = opSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  // Early whitelist check gives a cleaner 400 before hitting the lib.
  if (parsed.data.op === "pause_integration_feature" && !EMERGENCY_PAUSABLE_FLAGS.includes(parsed.data.flag)) {
    return NextResponse.json({ error: `Flag '${parsed.data.flag}' is not pausable via emergency controls`, code: "flag_not_allowed" }, { status: 400 });
  }

  const actor = { id: g.user.id, role: g.role };
  const result = await executeEmergencyOp(g.db, g.user, actor, parsed.data);

  if (!result.ok) {
    const status = result.status === 202 ? 202 : result.status;
    return NextResponse.json(
      {
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.pending ? { status: "pending", pending: true } : {}),
        ...(result.changeRequestId ? { changeRequestId: result.changeRequestId } : {}),
      },
      { status },
    );
  }
  return NextResponse.json({
    ok: true,
    op: result.op,
    summary: result.summary,
    expiresAt: result.expiresAt,
    changeRequestId: result.changeRequestId,
  });
}
