import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { MANIFEST_NOTE, MANIFEST_TABLES, MIGRATIONS } from "@/lib/system/database";

/**
 * GET /api/system/database/migrations — the generated migrations manifest.
 * Repo-order file list with titles/descriptions/tables; remote applied state is
 * explicitly NOT tracked per file. Requires system.database.schema.view.
 */
export async function GET() {
  const g = await systemApiGuard("system.database.schema.view", { limit: 120 });
  if (!g.ok) return g.res;
  return NextResponse.json({
    migrations: MIGRATIONS,
    tables: MANIFEST_TABLES,
    note: MANIFEST_NOTE,
    environment: process.env.VERCEL_ENV ?? "development",
  });
}
