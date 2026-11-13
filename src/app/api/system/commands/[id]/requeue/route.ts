import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { requeueDeviceCommand } from "@/lib/system/command-ops";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  /** Explicit operator confirmation — must be literally true. */
  confirm: z.literal(true),
  /** Justification recorded in audit — minimum 10 chars. */
  reason: z.string().trim().min(10).max(500),
  /** Required opt-in for physical commands (dispense|return_slot|unlock_slot). */
  allowPhysical: z.boolean().optional(),
  /** Evidence for dispense/return_slot retries when a contradictory ack exists:
   *  a resolved/dismissed rental_exceptions id, or a device_events id showing
   *  the previous attempt failed. */
  evidence_ref: z.string().trim().min(1).max(120).optional(),
});

/**
 * POST /api/system/commands/[id]/requeue — controlled retry of an EXISTING
 * device_commands row. Permission: system.kiosks.manage.
 *
 * Layers (all enforced server-side in lib/system/command-ops.ts):
 *   - fresh MFA elevation for PHYSICAL commands → 403 step_up_required
 *   - confirm:true + reason ≥10 chars (zod here, re-checked in lib)
 *   - device eligibility (bound system_devices active|testing, credential not
 *     revoked; unbound kiosk fallbacks) → 409 device_not_eligible / credential_revoked
 *   - capability check against resolved device capabilities → 409 capability_not_supported
 *   - dispense/return_slot evidence gate → 409 insufficient_evidence
 *   - lib state machine: only failed|cancelled|timeout|expired requeue;
 *     unknown_outcome/requires_investigation → 409 requires_investigation_escalation
 *   - physical commands additionally need allowPhysical:true → 409 physical_requires_review
 *   - idempotent: a second submit sees status 'queued' → 409 illegal_state; the
 *     lib's :rN idempotency suffix means a retried attempt never collides with
 *     the dead key.
 *
 * This route NEVER creates commands or accepts payloads — only requeues.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;

  const body = await readJson(req);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  const result = await requeueDeviceCommand(g.db, id, {
    user: g.user,
    actor: { id: g.user.id, role: g.role },
    reason: parsed.data.reason,
    allowPhysical: parsed.data.allowPhysical,
    evidenceRef: parsed.data.evidence_ref ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
  return NextResponse.json({
    ok: true,
    command_id: result.id,
    attempt: result.attempt,
    status: result.status,
    command: result.command,
    kiosk_id: result.kiosk_id,
    device_id: result.device_id,
    contradictory_ack: result.contradictory_ack,
    evidence: result.evidence,
  });
}
