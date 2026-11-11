import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { createExperiment, listExperiments, results } from "@/lib/experiments/service";
import { serviceClient } from "@/lib/supabase";

const variantSchema = z.object({
  key: z.string().trim().min(1).max(64),
  weight: z.coerce.number().int().positive().max(100000),
  config: z.record(z.string(), z.unknown()).optional(),
});

const createSchema = z.object({
  key: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  hypothesis: z.string().trim().max(2000).optional().nullable(),
  audience: z.string().trim().max(48).optional(),
  guardrail_metrics: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  start_at: z.string().trim().max(40).optional().nullable(),
  end_at: z.string().trim().max(40).optional().nullable(),
  variants: z.array(variantSchema).min(2).max(12),
}).strict();

/** Staff: list experiments with real per-variant results. */
export async function GET() {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const experiments = await listExperiments(db);
  const withResults = await Promise.all(experiments.map(async (e) => ({ ...e, results: await results(db, e.id) })));
  return NextResponse.json({ experiments: withResults });
}

/** Staff: create a draft experiment. Must be approved before it can run. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid experiment.", issues: parsed.error.issues.slice(0, 5) }, { status: 422 });

  const out = await createExperiment(db, { ...parsed.data, created_by: user.id });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
  await auditLog(user.id, "create_experiment", "experiment", out.data!.id, { key: parsed.data.key, variants: parsed.data.variants.length });
  return NextResponse.json({ ok: true, id: out.data!.id });
}
