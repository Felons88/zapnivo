import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, systemApiGuard } from "../../../../../../_shared";
import { catalogField, getContentRow, getSiteEntry, saveDraft } from "@/lib/system/site-cms";
import { assertApprovedOrRequest } from "@/lib/system/audit";

type Params = { params: Promise<{ site: string; page: string; field: string }> };

/** Resolve + whitelist-check route params. Returns the site entry or a response. */
async function resolve(ctx: Params) {
  const { site, page, field } = await ctx.params;
  if (!getSiteEntry(site)) return { error: NextResponse.json({ error: "Unknown site" }, { status: 404 }) };
  const def = catalogField(site, page, field);
  if (!def) return { error: NextResponse.json({ error: "Unknown content field" }, { status: 404 }) };
  return { site, page, field, def };
}

/**
 * GET /api/system/sites/[site]/pages/[page]/fields/[field] — one field's row.
 */
export async function GET(_req: Request, ctx: Params) {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const r = await resolve(ctx);
  if ("error" in r) return r.error;
  const row = await getContentRow(g.db, r.site, r.page, r.field);
  return NextResponse.json({ field: r.def, row });
}

const draftSchema = z.object({
  value: z.unknown(),
  justification: z.string().max(2000).optional(),
});

/**
 * PUT /api/system/sites/[site]/pages/[page]/fields/[field] — save a draft.
 * Perm: system.flags.manage (developer/engineer/sysadmin/breakglass). Breakglass
 * still needs an approved change request via assertApprovedOrRequest (risk low).
 * Validation + HTML stripping happen in saveDraft — unknown fields 404 here.
 */
export async function PUT(req: Request, ctx: Params) {
  const g = await systemApiGuard("system.flags.manage", { limit: 60 });
  if (!g.ok) return g.res;
  const r = await resolve(ctx);
  if ("error" in r) return r.error;
  const body = await readJson(req);
  const parsed = draftSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `sitecms.draft:${r.site}/${r.page}/${r.field}`,
    risk: "low",
    justification: parsed.data.justification ?? `Save CMS draft ${r.site}/${r.page}/${r.field}`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await saveDraft(g.db, actor, {
    siteKey: r.site,
    pageKey: r.page,
    fieldKey: r.field,
    value: parsed.data.value,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ row: result.data, changeRequestId: approval.changeRequestId });
}
