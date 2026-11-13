import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { catalogFields, catalogPages, getSiteEntry, listSiteContent } from "@/lib/system/site-cms";

/**
 * GET /api/system/sites/[site]/pages — catalog pages for a site plus the stored
 * content rows (draft/published/scheduled state per field).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ site: string }> }) {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { site } = await ctx.params;
  if (!getSiteEntry(site)) return NextResponse.json({ error: "Unknown site" }, { status: 404 });

  const rows = await listSiteContent(g.db, site);
  const byPage = new Map<string, unknown[]>();
  for (const r of rows) {
    const list = byPage.get(r.page_key) ?? [];
    list.push(r);
    byPage.set(r.page_key, list);
  }
  const pages = catalogPages(site).map((pageKey) => ({
    pageKey,
    fields: catalogFields(site, pageKey).map((d) => ({
      key: d.key,
      label: d.label,
      type: d.type,
      maxLength: d.maxLength ?? null,
      format: d.format ?? null,
      help: d.help ?? null,
      row: byPage.get(pageKey)?.find((r) => (r as { field_key: string }).field_key === d.key) ?? null,
    })),
  }));
  return NextResponse.json({ site, pages });
}
