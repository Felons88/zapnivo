import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, systemApiGuard } from "../../../../_shared";
import { getSiteEntry } from "@/lib/system/site-cms";
import { deleteMedia, isMediaCategory, updateMediaMeta, type MediaCategory } from "@/lib/system/site-media";
import { assertApprovedOrRequest } from "@/lib/system/audit";
import { requireElevation } from "@/lib/system/elevation";

type Params = { params: Promise<{ site: string; id: string }> };

async function resolve(ctx: Params) {
  const { site, id } = await ctx.params;
  if (!getSiteEntry(site)) return { error: NextResponse.json({ error: "Unknown site" }, { status: 404 }) };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { error: NextResponse.json({ error: "Unknown media" }, { status: 404 }) };
  return { site, id };
}

const patchSchema = z.object({
  alt_text: z.string().max(300).optional(),
  category: z.string().optional(),
  archived: z.boolean().optional(),
});

/**
 * PATCH /api/system/sites/[site]/media/[id] — update alt text, category, or the
 * archived (soft-delete) flag. Perm: system.flags.manage + change-request gate.
 */
export async function PATCH(req: Request, ctx: Params) {
  const g = await systemApiGuard("system.flags.manage", { limit: 60 });
  if (!g.ok) return g.res;
  const r = await resolve(ctx);
  if ("error" in r) return r.error;
  const body = await readJson(req);
  const parsed = patchSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  if (parsed.data.category !== undefined && !isMediaCategory(parsed.data.category)) {
    return NextResponse.json({ error: "Unknown category" }, { status: 422 });
  }

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `sitemedia.update:${r.site}/${r.id}`,
    risk: "low",
    justification: `Update site media ${r.site}/${r.id}`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await updateMediaMeta(g.db, actor, r.site, r.id, {
    altText: parsed.data.alt_text,
    category: parsed.data.category as MediaCategory | undefined,
    archived: parsed.data.archived,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ item: result.data });
}

/**
 * DELETE /api/system/sites/[site]/media/[id] — hard delete (storage object +
 * registry row). BLOCKED with 409 while published/draft content references it.
 * Perm: system.deployments.manage + live step-up elevation (destructive).
 */
export async function DELETE(req: Request, ctx: Params) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 20 });
  if (!g.ok) return g.res;
  const r = await resolve(ctx);
  if ("error" in r) return r.error;

  const elev = await requireElevation(g.db, g.user);
  if (!elev.ok) return NextResponse.json({ error: elev.error, code: elev.code }, { status: elev.status });

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `sitemedia.delete:${r.site}/${r.id}`,
    risk: "medium",
    justification: `Delete site media ${r.site}/${r.id}`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await deleteMedia(g.db, actor, r.site, r.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.refs ? { refs: result.refs } : {}) },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true });
}
