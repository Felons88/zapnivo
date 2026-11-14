import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, type SystemActor } from "./audit";
import {
  approveConfig, configRisk, dispatchConfig, proposeConfig, validateDesiredConfig,
  type ConfigRevisionRow, type DesiredConfig,
} from "./device-config";
import { getSystemDevice, isUuid, type SystemDeviceRow } from "./kiosks";
import {
  getGatewayAdapter, isGatewayUpdateCapable, updateCapabilitiesOf,
  type GatewayUpdateCapabilities,
} from "@/lib/kiosk/gateway-adapter";

/**
 * Config-kind update rollouts (Phase 4.3) — the bridge between
 * `kiosk_update_releases`/`kiosk_update_campaigns`/`kiosk_update_targets`
 * (migration 0067) and the desired-state config service
 * (`device-config.ts`, migration 0059).
 *
 * HONESTY MODEL
 * ─────────────
 * - A `kiosk_update_releases` row of kind='config' is METADATA ONLY — the
 *   schema has no payload column, so the whitelisted desired document MUST be
 *   supplied as `configPayload` and is validated by `validateDesiredConfig`
 *   before anything is written.
 * - `kiosk_update_targets.campaign_id` is NOT NULL: per-device update targets
 *   can only exist under a campaign. When a campaign exists for the release
 *   (explicit `campaignId`, or the latest non-terminal campaign on that
 *   release) targets are created state 'approved'→'queued' and linked to the
 *   device_config_revisions row via `result.config_revision_id`. WITHOUT a
 *   campaign the rollout runs STANDALONE: device_config_revisions rows only,
 *   no kiosk_update_targets rows — reported honestly as mode='standalone'.
 * - Target 'completed' is gated on REPORTED-STATE EVIDENCE: the linked
 *   device_config_revisions row must reach 'applied', which itself requires
 *   `reconcileReported` to have matched every desired key against a
 *   whitelist-filtered device report. There is still NO reported-config
 *   channel in ingest — until one exists revisions stall at
 *   awaiting_report/failed and targets stall at 'verifying'/'failed'.
 *   `refreshConfigRolloutTargets` is the only writer of target terminal
 *   states and it derives them exclusively from revision state.
 * - Dispatch goes through `dispatchConfig` per device. With
 *   KIOSK_ADAPTER=none that records command state='failed' /
 *   reason='adapter_disabled' and revision 'failed' — never 'sent'.
 *   `dispatchConfigRollout` additionally reports the resolved
 *   GatewayAdapter's update capabilities verbatim.
 */

/* ── Row shapes (0067 tables — read models only) ──────────────────────────── */

export type UpdateReleaseRow = {
  id: string;
  kind: "firmware" | "software" | "config" | "display_manifest";
  version: string;
  channel: string;
  status: string;
  signature_status: string;
  manufacturer: string | null;
  model: string | null;
  release_notes: string | null;
  created_at: string;
  approved_at: string | null;
};

export const UPDATE_RELEASE_SELECT =
  "id,kind,version,channel,status,signature_status,manufacturer,model,release_notes,created_at,approved_at";

export type UpdateCampaignRow = {
  id: string;
  release_id: string;
  name: string;
  status: string;
  target_filter: Record<string, unknown>;
  created_by: string | null;
  approved_by: string | null;
  created_at: string;
};

export const UPDATE_CAMPAIGN_SELECT =
  "id,release_id,name,status,target_filter,created_by,approved_by,created_at";

/** Campaign states that may still accept/queue targets. */
export const CAMPAIGN_TARGETABLE_STATUSES = [
  "draft", "pending_approval", "approved", "scheduled", "active", "paused",
] as const;

export type UpdateTargetRow = {
  id: string;
  campaign_id: string;
  device_id: string;
  state: string;
  attempt: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
  state_entered_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export const UPDATE_TARGET_SELECT =
  "id,campaign_id,device_id,state,attempt,last_error,result,state_entered_at,completed_at,created_at,updated_at";

export const CONFIG_ROLLOUT_MAX_DEVICES = 50;

/* ── Reads for panels/routes ──────────────────────────────────────────────── */

/** Config-kind releases, newest first. */
export async function listConfigReleases(db: SupabaseClient, limit = 50): Promise<UpdateReleaseRow[]> {
  const { data } = await db.from("kiosk_update_releases")
    .select(UPDATE_RELEASE_SELECT)
    .eq("kind", "config")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  return (data ?? []) as UpdateReleaseRow[];
}

async function getRelease(db: SupabaseClient, id: string): Promise<UpdateReleaseRow | null> {
  if (!isUuid(id)) return null;
  const { data } = await db.from("kiosk_update_releases")
    .select(UPDATE_RELEASE_SELECT).eq("id", id).maybeSingle();
  return (data as UpdateReleaseRow | null) ?? null;
}

async function getCampaign(db: SupabaseClient, id: string): Promise<UpdateCampaignRow | null> {
  if (!isUuid(id)) return null;
  const { data } = await db.from("kiosk_update_campaigns")
    .select(UPDATE_CAMPAIGN_SELECT).eq("id", id).maybeSingle();
  return (data as UpdateCampaignRow | null) ?? null;
}

/** Latest non-terminal campaign for a release, if one exists. */
export async function findCampaignForRelease(db: SupabaseClient, releaseId: string): Promise<UpdateCampaignRow | null> {
  const { data } = await db.from("kiosk_update_campaigns")
    .select(UPDATE_CAMPAIGN_SELECT)
    .eq("release_id", releaseId)
    .in("status", [...CAMPAIGN_TARGETABLE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? [])[0] as UpdateCampaignRow | undefined) ?? null;
}

/* ── proposeConfigRollout ─────────────────────────────────────────────────── */

export type ConfigRolloutInput = {
  /** Optional link to an approved kind='config' release (metadata only — the
   *  release row carries no payload; `configPayload` is always required). */
  releaseId?: string;
  /** Optional explicit campaign. When omitted, the latest non-terminal
   *  campaign on the release is used; with neither, the rollout is standalone. */
  campaignId?: string;
  deviceIds: string[];
  /** Whitelisted desired-state document (device-config.ts keys). */
  configPayload: unknown;
  justification?: string;
};

export type ConfigRolloutDeviceResult = {
  deviceId: string;
  ok: boolean;
  /** device_config_revisions row created (draft→approved attempt). */
  revisionId?: string;
  revisionStatus?: string;
  /** kiosk_update_targets row when a campaign exists. */
  targetId?: string;
  targetState?: string;
  /** approveConfig returned 202 — change request pending. */
  pending?: boolean;
  changeRequestId?: string;
  error?: string;
  status?: number;
};

export type ConfigRolloutResult =
  | {
      ok: true;
      mode: "campaign" | "standalone";
      release: UpdateReleaseRow | null;
      campaign: UpdateCampaignRow | null;
      devices: ConfigRolloutDeviceResult[];
      /** Summary counts for honest UI rendering. */
      summary: { proposed: number; approved: number; pending: number; failed: number };
    }
  | { ok: false; status: number; error: string };

async function upsertQueuedTarget(
  db: SupabaseClient,
  campaignId: string,
  deviceId: string,
  resultPatch: Record<string, unknown>,
): Promise<{ ok: true; target: UpdateTargetRow } | { ok: false; error: string }> {
  const { data: existing } = await db.from("kiosk_update_targets")
    .select(UPDATE_TARGET_SELECT)
    .eq("campaign_id", campaignId)
    .eq("device_id", deviceId)
    .maybeSingle();
  const now = new Date().toISOString();
  if (existing) {
    const cur = existing as UpdateTargetRow;
    const merged = { ...(cur.result ?? {}), ...resultPatch };
    const { data, error } = await db.from("kiosk_update_targets")
      .update({
        state: "queued",
        state_entered_at: now,
        updated_at: now,
        result: merged,
        last_error: null,
      })
      .eq("id", cur.id)
      .select(UPDATE_TARGET_SELECT).single();
    if (error || !data) return { ok: false, error: error?.message ?? "target update failed" };
    return { ok: true, target: data as UpdateTargetRow };
  }
  // approved → queued: insert approved then immediately transition, matching
  // the documented target lifecycle (draft→approved→scheduled→queued→…).
  const { data: ins, error: insErr } = await db.from("kiosk_update_targets").insert({
    campaign_id: campaignId,
    device_id: deviceId,
    state: "approved",
    result: resultPatch,
  }).select(UPDATE_TARGET_SELECT).single();
  if (insErr || !ins) return { ok: false, error: insErr?.message ?? "target insert failed" };
  const { data: queued, error: qErr } = await db.from("kiosk_update_targets")
    .update({ state: "queued", state_entered_at: now, updated_at: now })
    .eq("id", (ins as UpdateTargetRow).id)
    .select(UPDATE_TARGET_SELECT).single();
  if (qErr || !queued) return { ok: false, error: qErr?.message ?? "target queue failed" };
  return { ok: true, target: queued as UpdateTargetRow };
}

/**
 * Proposes a config rollout: validates the whitelisted desired document,
 * optionally links an approved config-kind release + campaign, then runs the
 * existing per-device proposeConfig → approveConfig path. Devices whose
 * approval needs a change request are recorded pending and get NO target.
 *
 * Per-device failures are collected, not fatal — one bad device does not
 * abort the rollout, but the response reports every outcome honestly.
 */
export async function proposeConfigRollout(
  db: SupabaseClient,
  actor: SystemActor,
  input: ConfigRolloutInput,
): Promise<ConfigRolloutResult> {
  const deviceIds = [...new Set((input.deviceIds ?? []).filter((d) => typeof d === "string" && isUuid(d)))];
  if (deviceIds.length === 0) return { ok: false, status: 400, error: "device_ids must contain at least one valid device id" };
  if (deviceIds.length > CONFIG_ROLLOUT_MAX_DEVICES) {
    return { ok: false, status: 400, error: `device_ids exceeds the ${CONFIG_ROLLOUT_MAX_DEVICES}-device rollout cap` };
  }
  if ((input.deviceIds ?? []).length !== deviceIds.length) {
    return { ok: false, status: 400, error: "device_ids contains duplicates or invalid ids" };
  }

  // The desired document is REQUIRED — config releases carry no payload column.
  const v = validateDesiredConfig(input.configPayload);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const desired: DesiredConfig = v.desired;
  const justification = input.justification?.trim() || undefined;

  // Resolve release linkage (metadata only).
  let release: UpdateReleaseRow | null = null;
  if (input.releaseId) {
    release = await getRelease(db, input.releaseId);
    if (!release) return { ok: false, status: 404, error: "Release not found" };
    if (release.kind !== "config") return { ok: false, status: 400, error: `Release kind is "${release.kind}" — config rollouts require kind='config'` };
    if (release.status !== "approved") return { ok: false, status: 409, error: `Release is ${release.status} — only approved releases may roll out` };
  }

  // Resolve campaign linkage.
  let campaign: UpdateCampaignRow | null = null;
  if (input.campaignId) {
    campaign = await getCampaign(db, input.campaignId);
    if (!campaign) return { ok: false, status: 404, error: "Campaign not found" };
    if (!(CAMPAIGN_TARGETABLE_STATUSES as readonly string[]).includes(campaign.status)) {
      return { ok: false, status: 409, error: `Campaign is ${campaign.status} — cannot accept new targets` };
    }
    if (release && campaign.release_id !== release.id) {
      return { ok: false, status: 400, error: "campaign_id does not belong to the given release" };
    }
    if (!release) {
      release = await getRelease(db, campaign.release_id);
      if (release && release.kind !== "config") {
        return { ok: false, status: 400, error: `Campaign release kind is "${release.kind}" — config rollouts require kind='config'` };
      }
    }
  } else if (release) {
    campaign = await findCampaignForRelease(db, release.id);
  }

  const devices: ConfigRolloutDeviceResult[] = [];
  for (const deviceId of deviceIds) {
    const device: SystemDeviceRow | null = await getSystemDevice(db, deviceId);
    if (!device) {
      devices.push({ deviceId, ok: false, status: 404, error: "Device not found" });
      continue;
    }
    const proposed = await proposeConfig(db, device, desired, actor);
    if (!proposed.ok) {
      devices.push({ deviceId, ok: false, status: proposed.status, error: proposed.error });
      continue;
    }
    const rev = proposed.revision;
    const approved = await approveConfig(db, device, rev.id, actor, justification);
    if (!approved.ok) {
      devices.push({
        // A pending change request is not a device failure — the proposal
        // succeeded; approval is gated. ok=true + pending=true.
        deviceId, ok: approved.pending === true, status: approved.status, error: approved.error,
        revisionId: rev.id, revisionStatus: rev.status,
        pending: approved.pending, changeRequestId: approved.changeRequestId,
      });
      continue;
    }
    const approvedRev = approved.revision;
    const entry: ConfigRolloutDeviceResult = {
      deviceId, ok: true, revisionId: approvedRev.id, revisionStatus: approvedRev.status,
    };
    if (campaign) {
      const t = await upsertQueuedTarget(db, campaign.id, deviceId, {
        config_revision_id: approvedRev.id,
        release_id: release?.id ?? null,
        desired,
        note: "config rollout — completion requires device_config_revisions 'applied' (reported-state match)",
      });
      if (t.ok) {
        entry.targetId = t.target.id;
        entry.targetState = t.target.state;
      } else {
        entry.error = `target write failed: ${t.error}`;
      }
    }
    devices.push(entry);
  }

  const summary = {
    proposed: devices.filter((d) => d.revisionId).length,
    approved: devices.filter((d) => d.revisionStatus === "approved").length,
    pending: devices.filter((d) => d.pending).length,
    failed: devices.filter((d) => !d.ok && !d.pending).length,
  };

  await systemAudit(db, {
    actor, action: "kiosk.config_rollout_proposed",
    resource: campaign ? `kiosk_update_campaign:${campaign.id}` : release ? `kiosk_update_release:${release.id}` : "kiosk_config_rollout:standalone",
    detail: {
      mode: campaign ? "campaign" : "standalone",
      release_id: release?.id ?? null, campaign_id: campaign?.id ?? null,
      device_count: deviceIds.length, desired_keys: Object.keys(desired),
      risk: configRisk(desired), summary,
    },
  });

  return {
    ok: true,
    mode: campaign ? "campaign" : "standalone",
    release, campaign, devices, summary,
  };
}

/* ── dispatchConfigRollout ────────────────────────────────────────────────── */

export type ConfigRolloutDispatchDevice = {
  deviceId: string;
  ok: boolean;
  dispatched: boolean;
  revisionId?: string;
  revisionStatus?: string;
  commandId?: string | null;
  commandState?: string | null;
  /** Honest reason when nothing was dispatched (adapter_disabled etc.). */
  reason?: string;
  error?: string;
  status?: number;
};

export type ConfigRolloutDispatchResult = {
  ok: true;
  adapter: {
    name: string;
    /** Base-surface flag (GatewayCapabilities.configUpdate). */
    configUpdate: boolean;
    /** Update-delivery flag (GatewayUpdateCapabilities.configUpdatePush). */
    configUpdatePush: boolean;
    updateCapable: boolean;
  };
  devices: ConfigRolloutDispatchDevice[];
  targetSync: { checked: number; changed: number };
};

/**
 * Dispatches each device's latest APPROVED config revision through the
 * existing dispatchConfig path. The resolved GatewayAdapter's capabilities
 * are reported verbatim; with KIOSK_ADAPTER=none every dispatch lands
 * command state='failed' / reason='adapter_disabled' — honest, never faked.
 * Afterwards target states are re-synced from revision state.
 */
export async function dispatchConfigRollout(
  db: SupabaseClient,
  actor: SystemActor,
  input: { deviceIds: string[] },
): Promise<ConfigRolloutDispatchResult | { ok: false; status: number; error: string }> {
  const deviceIds = [...new Set((input.deviceIds ?? []).filter((d) => typeof d === "string" && isUuid(d)))];
  if (deviceIds.length === 0) return { ok: false, status: 400, error: "device_ids must contain at least one valid device id" };
  if (deviceIds.length > CONFIG_ROLLOUT_MAX_DEVICES) {
    return { ok: false, status: 400, error: `device_ids exceeds the ${CONFIG_ROLLOUT_MAX_DEVICES}-device rollout cap` };
  }

  const adapter = getGatewayAdapter();
  const baseCaps = adapter.capabilities();
  const updateCaps: GatewayUpdateCapabilities = updateCapabilitiesOf(adapter);

  const devices: ConfigRolloutDispatchDevice[] = [];
  for (const deviceId of deviceIds) {
    const device = await getSystemDevice(db, deviceId);
    if (!device) {
      devices.push({ deviceId, ok: false, dispatched: false, status: 404, error: "Device not found" });
      continue;
    }
    // Latest approved revision for this device.
    const { data: revs } = await db.from("device_config_revisions")
      .select("id,revision,desired,status,command_id,reported,actor,created_at")
      .eq("device_id", device.id)
      .order("revision", { ascending: false })
      .limit(20);
    const approvedRev = ((revs ?? []) as ConfigRevisionRow[]).find((r) => r.status === "approved");
    if (!approvedRev) {
      devices.push({
        deviceId, ok: false, dispatched: false,
        error: "No approved config revision to dispatch",
        status: 409,
      });
      continue;
    }
    const r = await dispatchConfig(db, device, approvedRev.id, actor);
    if (!r.ok) {
      devices.push({ deviceId, ok: false, dispatched: false, revisionId: approvedRev.id, status: r.status, error: r.error });
      continue;
    }
    devices.push({
      deviceId, ok: true, dispatched: r.dispatched,
      revisionId: r.revision.id, revisionStatus: r.revision.status,
      commandId: r.command?.id ?? null, commandState: r.command?.state ?? null,
      // dispatchConfig already records result.reason on the command row; surface
      // the honest adapter state here too.
      reason: r.dispatched ? undefined : adapter.name === "blocked" ? "adapter_disabled" : "adapter_unavailable",
    });
  }

  const sync = await refreshConfigRolloutTargets(db, actor);
  return {
    ok: true,
    adapter: {
      name: adapter.name,
      configUpdate: baseCaps.configUpdate,
      configUpdatePush: updateCaps.configUpdatePush,
      updateCapable: isGatewayUpdateCapable(adapter),
    },
    devices,
    targetSync: { checked: sync.checked, changed: sync.changed },
  };
}

/* ── Reported-state verification / target sync ────────────────────────────── */

/**
 * Maps a device_config_revisions status onto the kiosk_update_targets state
 * machine. 'completed' is reachable ONLY from revision 'applied' — which
 * requires a whitelist-matched device report (reconcileReported). Pure so it
 * is unit-testable.
 */
export function configRevisionToTargetState(
  revisionStatus: string,
): { state: string; terminal: boolean; lastError?: string } {
  switch (revisionStatus) {
    case "applied":
      return { state: "completed", terminal: true };
    case "awaiting_report":
      return { state: "verifying", terminal: false };
    case "approved":
      return { state: "queued", terminal: false };
    case "failed":
      return { state: "failed", terminal: true, lastError: "config revision failed (see device_config_revisions / command result)" };
    case "superseded":
      return { state: "cancelled", terminal: true, lastError: "config revision superseded by a newer approved revision" };
    case "draft":
      return { state: "approved", terminal: false };
    default:
      return { state: "investigating", terminal: false };
  }
}

const SYNCABLE_TARGET_STATES = ["queued", "transferring", "installing", "reconnecting", "verifying", "approved", "scheduled"];

export type ConfigRolloutSyncResult = {
  checked: number;
  changed: number;
  completed: number;
  failed: number;
  verifying: number;
  unchanged: number;
};

/**
 * Re-derives kiosk_update_targets states from the linked
 * device_config_revisions row (result.config_revision_id). This is the ONLY
 * path that may move a config-rollout target to 'completed', and it does so
 * exclusively on revision 'applied' — i.e. authenticated reported-state
 * evidence. Never writes 'completed' from adapter acceptance alone.
 */
export async function refreshConfigRolloutTargets(
  db: SupabaseClient,
  actor?: SystemActor,
): Promise<ConfigRolloutSyncResult> {
  const auditActor = actor ?? { id: "system", role: "system" };
  const { data: targets } = await db.from("kiosk_update_targets")
    .select(UPDATE_TARGET_SELECT)
    .in("state", SYNCABLE_TARGET_STATES)
    .order("created_at", { ascending: true })
    .limit(500);

  const result: ConfigRolloutSyncResult = {
    checked: 0, changed: 0, completed: 0, failed: 0, verifying: 0, unchanged: 0,
  };

  for (const raw of (targets ?? []) as UpdateTargetRow[]) {
    const revisionId = typeof raw.result?.config_revision_id === "string" ? raw.result.config_revision_id : null;
    if (!revisionId || !isUuid(revisionId)) { result.unchanged++; continue; }
    result.checked++;
    const { data: revData } = await db.from("device_config_revisions")
      .select("id,device_id,revision,desired,status,command_id,reported,actor,created_at")
      .eq("id", revisionId).maybeSingle();
    const rev = revData as ConfigRevisionRow | null;
    if (!rev) { result.unchanged++; continue; }

    const mapped = configRevisionToTargetState(rev.status);
    if (mapped.state === raw.state) { result.unchanged++; continue; }

    const now = new Date().toISOString();
    const mergedResult = {
      ...(raw.result ?? {}),
      last_revision_status: rev.status,
      ...(mapped.state === "completed"
        ? { completed_evidence: { revision_status: "applied", reported: rev.reported, verified_at: now } }
        : {}),
    };
    const patch: Record<string, unknown> = {
      state: mapped.state,
      state_entered_at: now,
      updated_at: now,
      result: mergedResult,
      last_error: mapped.lastError ?? null,
    };
    if (mapped.terminal) patch.completed_at = now;

    const { error } = await db.from("kiosk_update_targets").update(patch).eq("id", raw.id);
    if (error) { result.unchanged++; continue; }

    result.changed++;
    if (mapped.state === "completed") result.completed++;
    else if (mapped.state === "failed") result.failed++;
    else if (mapped.state === "verifying") result.verifying++;

    await systemAudit(db, {
      actor: auditActor,
      action: "kiosk.update_target_state",
      resource: `kiosk_update_target:${raw.id}`,
      detail: {
        device_id: raw.device_id, campaign_id: raw.campaign_id,
        from: raw.state, to: mapped.state, revision_status: rev.status,
        evidence: mapped.state === "completed" ? "reported_config_match" : undefined,
      },
    });
  }
  return result;
}

/* ── Panel read model ─────────────────────────────────────────────────────── */

export type ConfigRolloutTargetView = {
  target: UpdateTargetRow;
  campaign: UpdateCampaignRow | null;
  release: UpdateReleaseRow | null;
  device: { id: string; device_uid: string | null; status: string } | null;
  revision: ConfigRevisionRow | null;
};

/** Recent config-rollout targets joined with campaign/release/device/revision. */
export async function listConfigRolloutTargets(
  db: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<ConfigRolloutTargetView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const { data: tdata } = await db.from("kiosk_update_targets")
    .select(UPDATE_TARGET_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);
  const targets = (tdata ?? []) as UpdateTargetRow[];
  if (targets.length === 0) return [];

  const campaignIds = [...new Set(targets.map((t) => t.campaign_id))];
  const { data: cdata } = await db.from("kiosk_update_campaigns")
    .select(UPDATE_CAMPAIGN_SELECT).in("id", campaignIds);
  const campaigns = new Map(((cdata ?? []) as UpdateCampaignRow[]).map((c) => [c.id, c]));

  const releaseIds = [...new Set([...campaigns.values()].map((c) => c.release_id))];
  const { data: rdata } = releaseIds.length
    ? await db.from("kiosk_update_releases").select(UPDATE_RELEASE_SELECT).in("id", releaseIds)
    : { data: [] };
  const releases = new Map(((rdata ?? []) as UpdateReleaseRow[]).map((r) => [r.id, r]));

  const revisionIds = [...new Set(targets
    .map((t) => t.result?.config_revision_id)
    .filter((v): v is string => typeof v === "string" && isUuid(v)))];
  const { data: vdata } = revisionIds.length
    ? await db.from("device_config_revisions")
        .select("id,device_id,revision,desired,status,command_id,reported,actor,created_at")
        .in("id", revisionIds)
    : { data: [] };
  const revisions = new Map(((vdata ?? []) as ConfigRevisionRow[]).map((r) => [r.id, r]));

  const deviceIds = [...new Set(targets.map((t) => t.device_id))];
  const { data: ddata } = await db.from("system_devices")
    .select("id,device_uid,status").in("id", deviceIds);
  const devices = new Map(((ddata ?? []) as { id: string; device_uid: string | null; status: string }[]).map((d) => [d.id, d]));

  return targets.map((t) => {
    const campaign = campaigns.get(t.campaign_id) ?? null;
    const release = campaign ? releases.get(campaign.release_id) ?? null : null;
    const revisionId = typeof t.result?.config_revision_id === "string" ? t.result.config_revision_id : null;
    return {
      target: t,
      campaign,
      release,
      device: devices.get(t.device_id) ?? null,
      revision: revisionId ? revisions.get(revisionId) ?? null : null,
    };
  });
}

