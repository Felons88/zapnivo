import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../_shared";
import { systemAudit } from "@/lib/system/audit";

/** GET /api/system/changes?status=pending — list change requests (system.changes.view). */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.changes.view", { limit: 120 });
  if (!g.ok) return g.res;
  const status = new URL(req.url).searchParams.get("status");
  let q = g.db.from("system_change_requests")
    .select("id,action,environment,risk,justification,status,requested_by,decided_by,decided_at,result,created_at")
    .order("created_at", { ascending: false }).limit(200);
  if (status && ["pending", "approved", "rejected", "executed", "failed"].includes(status)) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ changes: data ?? [] });
}

const createSchema = z.object({
  action: z.string().min(3).max(200),
  environment: z.string().max(40).optional(),
  risk: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  justification: z.string().min(10).max(4000),
});

/**
 * POST /api/system/changes — request a change (system.changes.request).
 * Always creates a PENDING request; it never executes anything itself.
 * High/critical-risk and breakglass-originated changes must be approved by a
 * different principal before the underlying mutation may run.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.changes.request", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const { data, error } = await g.db.from("system_change_requests").insert({
    action: parsed.data.action,
    environment: parsed.data.environment ?? process.env.VERCEL_ENV ?? "production",
    risk: parsed.data.risk,
    justification: parsed.data.justification,
    status: "pending",
    requested_by: g.user.id,
  }).select("id,action,environment,risk,status,created_at").single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "change.requested",
    resource: `change_request:${(data as { id: string }).id}`,
    detail: { action: parsed.data.action, risk: parsed.data.risk },
  });
  return NextResponse.json({ change: data }, { status: 201 });
}
