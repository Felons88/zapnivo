import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, systemApiGuard } from "../../../../../../../_shared";
import { catalogField, getSiteEntry, schedulePublish } from "@/lib/system/site-cms";
import { assertApprovedOrRequest } from "@/lib/system/audit";
import { requireElevation } from "@/lib/system/elevation";

type Params = { params: Promise<{ site: string; page: string; field: string }> };

const scheduleSchema = z.object({
  scheduledAt: z.string().min(10).max(40),
  justification: z.string().max(2000).optional(),
});

/**
 * POST /api/system/sites/[site]/pages/[page]/fields/[field]/schedule — snapshot
 * the draft to go live at a future time. Same gates as publish: deployments.manage
 * + step-up elevation + change-request rule for breakglass.
 */
export async function POST(req: Request, ctx: Params) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { site, page, field } = await ctx.params;
  if (!getSiteEntry(site) || !catalogField(site, page, field)) {
    return NextResponse.json({ error: "Unknown content field" }, { status: 404 });
  }
  const body = await readJson(req);
  const parsed = scheduleSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const elev = await requireElevation(g.db, g.user);
  if (!elev.ok) return NextResponse.json({ error: elev.error, code: elev.code }, { status: elev.status });

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `sitecms.schedule:${site}/${page}/${field}`,
    risk: "medium",
    justification: parsed.data.justification ?? `Schedule CMS field ${site}/${page}/${field} for ${parsed.data.scheduledAt}`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await schedulePublish(g.db, actor, {
    siteKey: site,
    pageKey: page,
    fieldKey: field,
    scheduledAt: parsed.data.scheduledAt,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ row: result.data });
}
