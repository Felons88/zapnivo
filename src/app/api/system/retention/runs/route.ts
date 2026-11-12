import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { listRetentionRuns } from "@/lib/system/retention";

/** GET /api/system/retention/runs — retention sweep history (newest first). */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.security.audit.view", { limit: 120 });
  if (!g.ok) return g.res;
  const limit = Math.min(Math.max(parseInt(new URL(req.url).searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  const { runs, error } = await listRetentionRuns(g.db, limit);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ runs });
}
