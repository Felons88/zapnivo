import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, systemApiGuard } from "../../../../../_shared";
import { getSiteEntry, revertToRevision } from "@/lib/system/site-cms";
import { assertApprovedOrRequest } from "@/lib/system/audit";
import { requireElevation } from "@/lib/system/elevation";

type Params = { params: Promise<{ site: string; rid: string }> };

const revertSchema = z.object({ justification: z.string().max(2000).optional() });

/**
 * POST /api/system/sites/[site]/revisions/[rid]/revert — restore published_value
 * from a prior revision. Same elevated gates as publish.
 */
export async function POST(req: Request, ctx: Params) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { site, rid } = await ctx.params;
  if (!getSiteEntry(site)) return NextResponse.json({ error: "Unknown site" }, { status: 404 });
  if (!/^[0-9a-f-]{36}$/i.test(rid)) return NextResponse.json({ error: "Invalid revision id" }, { status: 400 });
  const body = await readJson(req);
  const parsed = revertSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const elev = await requireElevation(g.db, g.user);
  if (!elev.ok) return NextResponse.json({ error: elev.error, code: elev.code }, { status: elev.status });

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `sitecms.revert:${site}/${rid}`,
    risk: "medium",
    justification: parsed.data.justification ?? `Revert CMS revision ${rid} on ${site}`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await revertToRevision(g.db, actor, { siteKey: site, revisionId: rid });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ row: result.data });
}
