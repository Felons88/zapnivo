import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { requireElevation } from "@/lib/system/elevation";
import {
  CONFIG_ROLLOUT_MAX_DEVICES, dispatchConfigRollout, proposeConfigRollout,
  refreshConfigRolloutTargets,
} from "@/lib/system/update-config";
import { configRisk, validateDesiredConfig } from "@/lib/system/device-config";

const postSchema = z.object({
  action: z.enum(["propose", "dispatch", "refresh"]),
  release_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  /** Whitelisted desired-state document (device-config.ts keys). */
  config: z.record(z.string(), z.unknown()).optional(),
  device_ids: z.array(z.string().uuid()).min(1).max(CONFIG_ROLLOUT_MAX_DEVICES).optional(),
  justification: z.string().trim().max(500).optional(),
}).strict();

/** Bulk threshold above which step-up elevation is mandatory. */
const ELEVATION_BULK_THRESHOLD = 10;

/**
 * POST /api/system/updates/config — config-kind update rollouts.
 * Permission: system.kiosks.manage.
 *
 *   propose  { config, device_ids, release_id?, campaign_id?, justification? }
 *            → per-device device_config_revisions (propose→approve) plus
 *              kiosk_update_targets 'queued' rows when a campaign exists.
 *   dispatch { device_ids }
 *            → dispatchConfig per device; adapter=none records honest
 *              adapter_disabled failures, never fake success.
 *   refresh  {}
 *            → re-derive target states from device_config_revisions;
 *              'completed' only on reported-state 'applied' evidence.
 *
 * Step-up elevation is required for bulk rollouts (>10 devices) or whenever
 * the desired document carries medium+ risk keys (e.g. maintenance_mode).
 * Per-device change-request gating still applies inside approveConfig.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;
  const actor = { id: g.user.id, role: g.role };

  if (d.action === "refresh") {
    const r = await refreshConfigRolloutTargets(g.db, actor);
    return NextResponse.json(r);
  }

  const deviceIds = d.device_ids ?? [];
  if (deviceIds.length === 0) {
    return NextResponse.json({ error: "device_ids is required" }, { status: 400 });
  }

  // Elevation gate: bulk blast radius OR medium+ risk desired state.
  let risk: "low" | "medium" | "high" | "critical" = "low";
  if (d.action === "propose" && d.config) {
    const v = validateDesiredConfig(d.config);
    if (v.ok) risk = configRisk(v.desired);
  }
  if (deviceIds.length > ELEVATION_BULK_THRESHOLD || risk !== "low") {
    const elev = await requireElevation(g.db, g.user);
    if (!elev.ok) {
      return NextResponse.json({ error: elev.error, code: elev.code ?? "step_up_required" }, { status: elev.status });
    }
  }

  if (d.action === "propose") {
    if (!d.config) return NextResponse.json({ error: "config is required" }, { status: 400 });
    const r = await proposeConfigRollout(g.db, actor, {
      releaseId: d.release_id,
      campaignId: d.campaign_id,
      deviceIds,
      configPayload: d.config,
      justification: d.justification,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json(r, { status: 201 });
  }

  // dispatch
  const r = await dispatchConfigRollout(g.db, actor, { deviceIds });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
