import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { validateRotationRequest } from "@/lib/system/integrations";
import { assertApprovedOrRequest, systemAudit } from "@/lib/system/audit";

const rotateSchema = z.object({
  provider: z.string().max(60).optional(),
  env_var_name: z.string().min(1).max(120),
  /** Optional — shape-validated only; NEVER stored, logged, or forwarded. */
  new_value: z.string().max(500).optional(),
  justification: z.string().max(2000).optional(),
});

/**
 * POST /api/system/secrets/rotate — request-tracked credential rotation.
 *
 * DESIGN: this endpoint does NOT write to Vercel env (no verified API token)
 * and does NOT store the submitted value anywhere. It validates the env var
 * against the credential registry (allowlist — rejects unknown names),
 * shape-checks an optional value, creates an approved-via-change-request
 * record (risk=high), audits the request, and returns manual rotation
 * instructions. The actual env write is a manual Vercel dashboard step.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.secrets.rotate", { limit: 10 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = rotateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const check = validateRotationRequest(parsed.data);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 422 });
  const { envVar, meta } = check;
  const submittedValue = typeof parsed.data.new_value === "string" && parsed.data.new_value.length > 0;

  const actor = { id: g.user.id, role: g.role };
  const action = `secret.rotate:${envVar}`;
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action,
    risk: "high",
    justification:
      (parsed.data.justification ?? `Rotate credential ${envVar} (${meta.provider}). `) +
      `Env writes are manual via the Vercel dashboard — this request tracks the rotation only.` +
      (submittedValue ? " A candidate value was submitted for shape validation only; it was NOT stored." : ""),
  });
  if (approval.status === "pending") {
    await systemAudit(g.db, {
      actor, action: "secret.rotation_requested", resource: `secret:${envVar}`,
      detail: { provider: meta.provider, changeRequestId: approval.changeRequestId, valueSubmitted: submittedValue },
    });
    return NextResponse.json({
      status: "pending",
      changeRequestId: approval.changeRequestId,
      message: "Approval required — change request created. Rotation is request-tracked; the env write itself is a manual Vercel step.",
      instructions: meta.rotation,
    }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  // Approved (or non-high-risk path): still no env write — return instructions.
  await systemAudit(g.db, {
    actor, action: "secret.rotation_requested", resource: `secret:${envVar}`,
    detail: { provider: meta.provider, changeRequestId: approval.changeRequestId, valueSubmitted: submittedValue, approved: true },
  });
  return NextResponse.json({
    status: "instructions",
    changeRequestId: approval.changeRequestId,
    envVar,
    provider: meta.provider,
    message: "Rotation approved/tracked. Complete the manual step in the Vercel dashboard — this system never writes env vars and never stores the secret value.",
    instructions: meta.rotation,
    manualSteps: [
      `Vercel → Project → Settings → Environment Variables → update ${envVar} (Production + Preview as needed)`,
      "Redeploy so the new value takes effect",
      "Revoke/expire the old credential at the provider",
      "Run the integration health check to verify",
    ],
  });
}
