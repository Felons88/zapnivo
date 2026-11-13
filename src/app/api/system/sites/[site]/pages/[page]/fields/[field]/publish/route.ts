import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, systemApiGuard } from "../../../../../../../_shared";
import { catalogField, getSiteEntry, publishDraft } from "@/lib/system/site-cms";
import { assertApprovedOrRequest } from "@/lib/system/audit";
import { requireElevation } from "@/lib/system/elevation";

type Params = { params: Promise<{ site: string; page: string; field: string }> };

const publishSchema = z.object({ justification: z.string().max(2000).optional() });

/**
 * POST /api/system/sites/[site]/pages/[page]/fields/[field]/publish — publish the
 * current draft to the live site. Perm: system.deployments.manage PLUS a live
 * step-up elevation (publishing public content is elevated-risk). Breakglass
 * additionally needs an approved change request.
 */
export async function POST(req: Request, ctx: Params) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { site, page, field } = await ctx.params;
  if (!getSiteEntry(site) || !catalogField(site, page, field)) {
    return NextResponse.json({ error: "Unknown content field" }, { status: 404 });
  }
  const body = await readJson(req);
  const parsed = publishSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const elev = await requireElevation(g.db, g.user);
  if (!elev.ok) return NextResponse.json({ error: elev.error, code: elev.code }, { status: elev.status });

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `sitecms.publish:${site}/${page}/${field}`,
    risk: "medium",
    justification: parsed.data.justification ?? `Publish CMS field ${site}/${page}/${field}`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await publishDraft(g.db, actor, { siteKey: site, pageKey: page, fieldKey: field });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ row: result.data });
}
