import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { recordRecoveryTest, isRecoveryMethod } from "@/lib/system/recovery";

const testSchema = z.object({
  testedAt: z.string().max(40).optional(),
  environment: z.string().max(40).default("production"),
  method: z.string().max(60).default(""),
  result: z.enum(["passed", "failed", "partial"]),
  rpoMinutes: z.number().int().min(0).max(525600).nullish(),
  rtoMinutes: z.number().int().min(0).max(525600).nullish(),
  notes: z.string().max(4000).optional(),
});

/**
 * POST /api/system/recovery/tests — record a MANUALLY-performed recovery test.
 * Perm: system.changes.request — chosen because it is the only manage-class
 * permission shared by engineer, security, hardware, sysadmin and breakglass
 * (deployments.manage would exclude the security role that owns DR sign-off).
 * This endpoint records a claim; it does not perform or verify a restore.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.changes.request", { limit: 30 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = testSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  if (parsed.data.method && !isRecoveryMethod(parsed.data.method)) {
    return NextResponse.json({ error: `method must be one of: ${["supabase_backup_restore","supabase_pitr","point_in_time_dump","manual_sql","other"].join(", ")}` }, { status: 400 });
  }

  const result = await recordRecoveryTest(g.db, { id: g.user.id, role: g.role }, {
    testedAt: parsed.data.testedAt,
    environment: parsed.data.environment,
    method: parsed.data.method,
    result: parsed.data.result,
    rpoMinutes: parsed.data.rpoMinutes ?? null,
    rtoMinutes: parsed.data.rtoMinutes ?? null,
    notes: parsed.data.notes,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ test: result.test }, { status: 201 });
}
