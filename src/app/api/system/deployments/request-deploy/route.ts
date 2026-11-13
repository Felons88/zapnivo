import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { requestDeploy } from "@/lib/system/deploy-center";

const schema = z.object({
  ref: z.string().min(1).max(200),
  env: z.enum(["preview", "production"]),
  justification: z.string().min(10).max(4000),
});

/**
 * POST /api/system/deployments/request-deploy — create an approval-gated
 * deploy request for a specific git ref.
 * Perm: system.deployments.manage.
 *  - production → high risk: needs an approved change request first (202).
 *  - preview    → medium risk: proceeds for non-breakglass roles.
 * The git ref must be in the allowed deploy-ref set (GITHUB_DEPLOY_REFS,
 * default "main" only) — checked before any provider interaction.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 30 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const actor = { id: g.user.id, role: g.role };
  const result = await requestDeploy(g.db, actor, {
    ref: parsed.data.ref,
    targetEnv: parsed.data.env,
    justification: parsed.data.justification,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (result.status === "pending_approval") {
    return NextResponse.json({ status: "pending_approval", changeRequestId: result.changeRequestId, message: "Production deploys are high-risk — a change request was created and must be approved by a different principal first." }, { status: 202 });
  }
  return NextResponse.json({ status: "created", requestId: result.requestId }, { status: 201 });
}
