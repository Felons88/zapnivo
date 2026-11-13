import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import {
  APP_PROFILES,
  healthProfileApps,
  healthProfileFor,
  runAndRecordHealthProfile,
} from "@/lib/system/deploy-health";

/**
 * GET /api/system/deployments/health-profile — profile DEFINITIONS only
 * (hosts + check specs). No network calls. Perm: system.deployments.view.
 */
export async function GET() {
  const g = await systemApiGuard("system.deployments.view", { limit: 120 });
  if (!g.ok) return g.res;
  return NextResponse.json({
    apps: healthProfileApps(),
    profiles: APP_PROFILES.map((p) => ({
      app: p.app,
      label: p.label,
      checks: p.checks.map((c) => ({
        id: c.id, kind: c.kind, path: c.path ?? "/", expect: c.expect,
        critical: c.critical, note: c.note ?? null,
      })),
    })),
  });
}

const runSchema = z.object({
  app: z.string().min(1).max(40),
});

/**
 * POST /api/system/deployments/health-profile {app} — run one app health
 * profile NOW against production. Perm: system.deployments.manage (it fans
 * out real HTTPS probes and writes uptime_checks + audit events).
 *
 * Read-only by construction: checks are unauthenticated GET/HEAD on public
 * paths of approved hosts only — no auth attempts, no mutations, no secrets.
 * Result: { status: 'healthy'|'degraded'|'unreachable', checks: [...] }.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 20 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request — { app } required", issues: parsed.error.issues }, { status: 400 });
  }
  const profile = healthProfileFor(parsed.data.app);
  if (!profile) {
    return NextResponse.json({
      error: `unknown app '${parsed.data.app}'`,
      known: APP_PROFILES.map((p) => p.app),
    }, { status: 400 });
  }

  const actor = { id: g.user.id, role: g.role };
  const result = await runAndRecordHealthProfile(g.db, actor, parsed.data.app);
  return NextResponse.json(result, { status: result.status === "unreachable" ? 502 : 200 });
}
