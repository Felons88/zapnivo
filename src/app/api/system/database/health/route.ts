import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getDatabaseHealth } from "@/lib/system/database";

/**
 * GET /api/system/database/health — bounded connectivity probe + per-table
 * exact head counts. Read-only; each table reports its own error honestly.
 * Requires system.database.schema.view.
 */
export async function GET() {
  const g = await systemApiGuard("system.database.schema.view", { limit: 60 });
  if (!g.ok) return g.res;
  const health = await getDatabaseHealth(g.db);
  return NextResponse.json({ health, environment: process.env.VERCEL_ENV ?? "development" });
}
