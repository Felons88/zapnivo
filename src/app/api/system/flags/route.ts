import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../_shared";
import { listFeatureFlags, setFeatureFlag } from "@/lib/system/flags";
import { assertApprovedOrRequest } from "@/lib/system/audit";

/** GET /api/system/flags — list feature flags (system.flags.view). */
export async function GET() {
  const g = await systemApiGuard("system.flags.view", { limit: 120 });
  if (!g.ok) return g.res;
  const flags = await listFeatureFlags(g.db);
  return NextResponse.json({ flags });
}

const toggleSchema = z.object({
  key: z.string().min(1).max(80),
  enabled: z.boolean(),
  environment: z.string().max(40).optional(),
  justification: z.string().max(2000).optional(),
});

/**
 * POST /api/system/flags — toggle a flag (system.flags.manage: sysadmin,
 * engineer, developer, breakglass). Writes the flag row + a system audit event.
 * Flags are metadata only — env vars still govern runtime behavior.
 *
 * Mutations go through assertApprovedOrRequest: breakglass callers and
 * high/critical-risk toggles return {status:"pending"} + a change request id
 * instead of executing. (Flag toggles default to 'medium' risk → proceed.)
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.flags.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = toggleSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `flag.${parsed.data.enabled ? "enable" : "disable"}:${parsed.data.key}`,
    environment: parsed.data.environment,
    risk: "medium",
    justification: parsed.data.justification ?? `Toggle feature flag ${parsed.data.key} → ${parsed.data.enabled ? "enabled" : "disabled"} (metadata only)`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId, message: "Approval required — change request created." }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await setFeatureFlag(g.db, actor, {
    key: parsed.data.key,
    enabled: parsed.data.enabled,
    environment: parsed.data.environment,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ flag: result.flag, changeRequestId: approval.changeRequestId });
}
