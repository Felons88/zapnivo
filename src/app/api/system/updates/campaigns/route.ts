import { NextResponse } from "next/server";
import { systemApiGuard, readJson } from "../../_shared";
import {
  createCampaign, listCampaignsWithMeta, listApprovedReleases,
} from "@/lib/system/update-rollouts";

/**
 * GET  /api/system/updates/campaigns — campaign list + approved releases
 *      (permission: system.kiosks.view)
 * POST /api/system/updates/campaigns — create a campaign in 'pending_approval'
 *      (permission: system.kiosks.manage). The linked release must be
 *      status='approved'; incompatible devices are excluded with reasons.
 */
export async function GET() {
  const g = await systemApiGuard("system.kiosks.view", { limit: 60 });
  if (!g.ok) return g.res;
  const [campaigns, approvedReleases] = await Promise.all([
    listCampaignsWithMeta(g.db, 100),
    listApprovedReleases(g.db),
  ]);
  return NextResponse.json({ campaigns, approved_releases: approvedReleases });
}

export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 10, windowMs: 60_000 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const r = await createCampaign(g.db, { id: g.user.id, role: g.role }, body);
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, code: r.code, excluded: "excluded" in r ? r.excluded : undefined },
      { status: r.status },
    );
  }
  return NextResponse.json(
    { campaign: r.campaign, target_count: r.targetCount, excluded: r.excluded },
    { status: 201 },
  );
}
