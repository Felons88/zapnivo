import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { SITE_REGISTRY, catalogPages, siteContentCounts } from "@/lib/system/site-cms";

/**
 * GET /api/system/sites — site registry (7 hosts) with classification and
 * content-row counts. Read perm: system.dashboard.view (every system role).
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const counts = await siteContentCounts(g.db);
  const sites = SITE_REGISTRY.map((s) => ({
    ...s,
    editablePages: catalogPages(s.key),
    contentRows: counts[s.key] ?? 0,
  }));
  return NextResponse.json({ sites });
}
