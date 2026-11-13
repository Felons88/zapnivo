import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../_shared";
import { getDeploymentInfo } from "@/lib/system/appinfra";
import { listDeploymentRequests, createDeploymentRequest, isDeployAction } from "@/lib/system/deployops";
import { listDeployments } from "@/lib/system/deploy-center";
import { assertApprovedOrRequest } from "@/lib/system/audit";

/** GET /api/system/deployments — deployment info + provider-merged records + request history. */
export async function GET() {
  const g = await systemApiGuard("system.deployments.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { requests, error } = await listDeploymentRequests(g.db, 100);
  const center = await listDeployments(g.db, { probe: false, limit: 50 });
  return NextResponse.json({
    deployment: getDeploymentInfo(),
    requests,
    requestsError: error,
    // Provider-merged deployment records (vercel_api + approval_request sources).
    deployments: center.deployments,
    providers: center.providers,
    vercelError: center.vercelError,
    execution: "manual_only",
    executionNote: "Approved requests resolve to awaiting_manual_deploy unless VERCEL_TOKEN+VERCEL_PROJECT_ID are configured — then POST /api/system/deployments/[id]/execute calls the Vercel API.",
  });
}

const createSchema = z.object({
  action: z.string(),
  targetEnv: z.enum(["production", "preview", "development"]).default("production"),
  justification: z.string().min(10).max(4000),
});

/**
 * POST /api/system/deployments — create a deployment request.
 * Perm: system.deployments.manage. Requests are high-risk by nature, so
 * creation itself is gated by assertApprovedOrRequest(risk:'high'): the first
 * attempt returns 202 pending_approval with a system_change_requests row that
 * a different principal must approve before the request is created.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 30 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  if (!isDeployAction(parsed.data.action)) {
    return NextResponse.json({ error: "action must be one of: deploy, rollback, promote" }, { status: 400 });
  }

  const actor = { id: g.user.id, role: g.role };
  const gate = await assertApprovedOrRequest(g.db, actor, {
    action: `deployment.request:${parsed.data.action}`,
    risk: "high",
    justification: parsed.data.justification,
  });
  if (gate.status === "pending") {
    return NextResponse.json({ status: "pending_approval", changeRequestId: gate.changeRequestId, message: "Deployment requests are high-risk — a change request was created and must be approved by a different principal first." }, { status: 202 });
  }
  if (gate.status === "rejected") {
    return NextResponse.json({ error: "A previous change request for this action was rejected", changeRequestId: gate.changeRequestId }, { status: 409 });
  }
  if (gate.status === "error") {
    return NextResponse.json({ error: gate.error }, { status: 500 });
  }

  const result = await createDeploymentRequest(g.db, actor, {
    action: parsed.data.action,
    targetEnv: parsed.data.targetEnv,
    justification: parsed.data.justification,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ request: result.request }, { status: 201 });
}
