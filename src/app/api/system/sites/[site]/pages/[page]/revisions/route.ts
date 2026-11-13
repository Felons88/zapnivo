import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../../../_shared";
import { getSiteEntry, listPageRevisions } from "@/lib/system/site-cms";

/**
 * GET /api/system/sites/[site]/pages/[page]/revisions — revision history across
 * all catalog fields on the page (newest first).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ site: string; page: string }> }) {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { site, page } = await ctx.params;
  if (!getSiteEntry(site)) return NextResponse.json({ error: "Unknown site" }, { status: 404 });
  const revisions = await listPageRevisions(g.db, site, page);
  return NextResponse.json({ revisions });
}
