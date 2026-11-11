import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { pingAllowlisted } from "@/lib/system/devtools";
import { systemAudit } from "@/lib/system/audit";

const schema = z.object({
  path: z.string().trim().max(200),
});

/**
 * POST /api/system/dev/ping — allowlisted GET proxy for the API explorer
 * "try it" panel. Rate-limited to 30/min. Forwards ONLY the caller's cookie
 * (their own session/role applies upstream) — no arbitrary URLs, no POST, no
 * header injection. Response body capped at 8KB. Audited.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.dashboard.view", { limit: 30, windowMs: 60_000 });
  if (!g.ok) return g.res;

  const raw = await readJson(req);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body — { path } required" }, { status: 422 });

  const result = await pingAllowlisted(req, parsed.data.path);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "dev.ping",
    resource: `dev:ping:${parsed.data.path}`,
    detail: result.ok ? { status: result.status, latencyMs: result.latencyMs } : { error: result.error },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
