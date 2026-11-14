import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { requireElevation } from "@/lib/system/elevation";
import {
  getUpdateCampaign, getUpdateRelease, listUpdateTargets,
  submitCampaign, approveCampaign, activateCampaign, pauseCampaign,
  resumeCampaign, cancelCampaign, campaignNeedsElevation,
} from "@/lib/system/update-rollouts";

/**
 * GET  /api/system/updates/campaigns/[id] — campaign + release + targets
 *      (permission: system.kiosks.view)
 * POST /api/system/updates/campaigns/[id] — lifecycle action
 *      (permission: system.kiosks.manage)
 *      { action: "submit" | "approve" | "activate" | "pause" | "resume" | "cancel",
 *        reason?: string, justification?: string }
 *
 * approve/activate on firmware|software releases additionally require a fresh
 * MFA elevation (requireElevation → 403 step_up_required otherwise). Campaign
 * approval enforces approver ≠ creator inside the engine.
 */

const actionSchema = z.object({
  action: z.enum(["submit", "approve", "activate", "pause", "resume", "cancel"]),
  reason: z.string().trim().max(500).optional(),
  justification: z.string().trim().max(2000).optional(),
}).strict();

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 60 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const campaign = await getUpdateCampaign(g.db, id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  const [release, targets] = await Promise.all([
    getUpdateRelease(g.db, campaign.release_id),
    listUpdateTargets(g.db, { campaignId: id, limit: 500 }),
  ]);
  return NextResponse.json({ campaign, release, targets });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 20, windowMs: 60_000 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const body = await readJson(req);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid action", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }
  const { action, reason, justification } = parsed.data;
  const actor = { id: g.user.id, role: g.role };

  // Elevation gate for physical kinds — resolved BEFORE calling the engine so
  // the user gets a clean step_up_required instead of a post-hoc failure.
  let elevationOk = false;
  if (action === "approve" || action === "activate") {
    const campaign = await getUpdateCampaign(g.db, id);
    if (campaign) {
      const release = await getUpdateRelease(g.db, campaign.release_id);
      if (release && campaignNeedsElevation(release.kind)) {
        const elev = await requireElevation(g.db, g.user);
        if (!elev.ok) {
          return NextResponse.json({ error: elev.error, code: elev.code }, { status: elev.status });
        }
        elevationOk = true;
      }
    }
  }

  const r =
    action === "submit" ? await submitCampaign(g.db, id, actor)
    : action === "approve" ? await approveCampaign(g.db, id, actor, { elevationOk, justification })
    : action === "activate" ? await activateCampaign(g.db, id, actor, { elevationOk })
    : action === "pause" ? await pauseCampaign(g.db, id, actor, reason)
    : action === "resume" ? await resumeCampaign(g.db, id, actor)
    : await cancelCampaign(g.db, id, actor, reason);

  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, code: r.code, pending: r.pending, changeRequestId: r.changeRequestId },
      { status: r.status },
    );
  }
  const out: Record<string, unknown> = { campaign: r.campaign };
  const extra = r as { dispatched?: number; dispatches?: unknown; cancelledTargets?: number };
  if (typeof extra.dispatched === "number") {
    out.dispatched = extra.dispatched;
    out.dispatches = extra.dispatches;
  }
  if (typeof extra.cancelledTargets === "number") out.cancelled_targets = extra.cancelledTargets;
  return NextResponse.json(out);
}
