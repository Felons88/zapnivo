import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { systemAudit, assertApprovedOrRequest, type ChangeRisk, type SystemActor } from "./audit";
import { getSystemDevice, isUuid, kioskAdapterName, type SystemDeviceRow } from "./kiosks";
import { HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";
import { getGatewayAdapter, type GatewayAdapter } from "@/lib/kiosk/gateway-adapter";

/**
 * Kiosk update rollout engine (Phase 4.3, migration 0067).
 *
 * Three state machines live here:
 *
 *   kiosk_update_releases   draft → approved → deprecated|revoked  (registry;
 *                           approval/signature enforcement lives in the
 *                           release-management module + DB constraints)
 *   kiosk_update_campaigns  draft → pending_approval → approved → scheduled →
 *                           active → paused → completed|failed|cancelled|blocked
 *   kiosk_update_targets    draft → approved → scheduled → queued → transferring
 *                           → installing → reconnecting → verifying → completed
 *                           with failed | unknown_outcome | investigating |
 *                           recovery | cancelled branches
 *
 * SAFETY INVARIANTS (never violated here):
 *  - Physical dispatch goes ONLY through getGatewayAdapter(). With
 *    KIOSK_ADAPTER=none every call fails closed; a target may reach 'queued'
 *    (command recorded, awaiting a gateway) but NEVER 'transferring'/
 *    'installing' without adapter evidence, and NEVER 'completed' without
 *    device-reported verification (see verifyTargetCompletion).
 *  - Any target entering 'unknown_outcome' or 'failed' with a critical error
 *    auto-blocks the whole campaign. Blocked campaigns never auto-expand and
 *    never auto-retry — the only exit is manual 'cancelled' (a retry is a NEW
 *    campaign, optionally against the previous release = rollback-by-campaign).
 *  - Campaign approval is separation-of-duties (approver ≠ creator) and
 *    firmware/software kinds additionally require a fresh MFA elevation —
 *    the route layer supplies `elevationOk` from requireElevation().
 */

/* ── Row shapes ──────────────────────────────────────────────────────────── */

export const RELEASE_KINDS = ["firmware", "software", "config", "display_manifest"] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];

export type UpdateReleaseRow = {
  id: string;
  kind: ReleaseKind;
  version: string;
  channel: string;
  manufacturer: string | null;
  model: string | null;
  hw_revision_min: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  sha256: string | null;
  signature_status: string;
  signature_key_id: string | null;
  release_notes: string | null;
  status: string;
  uploaded_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export const UPDATE_RELEASE_SELECT =
  "id,kind,version,channel,manufacturer,model,hw_revision_min,storage_bucket,storage_path,sha256,signature_status,signature_key_id,release_notes,status,uploaded_by,approved_by,approved_at,created_at,updated_at";

export const CAMPAIGN_STATUSES = [
  "draft", "pending_approval", "approved", "scheduled", "active", "paused",
  "completed", "failed", "cancelled", "blocked",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export type UpdateCampaignRow = {
  id: string;
  release_id: string;
  name: string;
  justification: string;
  status: CampaignStatus;
  target_filter: Record<string, unknown>;
  maintenance_window: Record<string, unknown> | null;
  concurrency_limit: number;
  pause_reason: string | null;
  result: Record<string, unknown> | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export const CAMPAIGN_SELECT =
  "id,release_id,name,justification,status,target_filter,maintenance_window,concurrency_limit,pause_reason,result,created_by,approved_by,approved_at,started_at,finished_at,created_at,updated_at";

export const TARGET_STATES = [
  "draft", "approved", "scheduled", "queued", "transferring", "installing",
  "reconnecting", "verifying", "completed",
  "failed", "unknown_outcome", "investigating", "recovery", "cancelled",
] as const;
export type TargetState = (typeof TARGET_STATES)[number];

export type UpdateTargetRow = {
  id: string;
  campaign_id: string;
  device_id: string;
  state: TargetState;
  attempt: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
  state_entered_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export const TARGET_SELECT =
  "id,campaign_id,device_id,state,attempt,last_error,result,state_entered_at,completed_at,created_at,updated_at";

/* ── Transition graphs (pure, unit-tested) ───────────────────────────────── */

/**
 * Campaign lifecycle. 'blocked' is a safety halt: the ONLY exit is
 * 'cancelled' — recovery is always a NEW campaign (never an auto-retry).
 * 'approved' may return to 'draft' for corrections before scheduling.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ["pending_approval"],
  pending_approval: ["approved", "cancelled"],
  approved: ["scheduled", "active", "draft", "cancelled"],
  scheduled: ["active", "paused", "cancelled"],
  active: ["paused", "completed", "failed", "cancelled", "blocked"],
  paused: ["active", "completed", "cancelled", "blocked"],
  blocked: ["cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function validCampaignTransition(from: string, to: string): boolean {
  const f = from as CampaignStatus;
  return (CAMPAIGN_TRANSITIONS[f] ?? []).includes(to as CampaignStatus);
}

export const TERMINAL_CAMPAIGN_STATES: readonly CampaignStatus[] = ["completed", "failed", "cancelled"];
export const isTerminalCampaign = (s: string) => TERMINAL_CAMPAIGN_STATES.includes(s as CampaignStatus) || s === "blocked";

/**
 * Per-device update state machine. 'queued' means the update command is
 * recorded/handed to a gateway — it is NOT proof of physical progress.
 * 'transferring'+ require adapter evidence (a real gateway ack path).
 * 'investigating' is the honest holding state when verification evidence is
 * missing or contradictory; 'recovery' marks a target being rolled back to a
 * previous release (itself a new campaign/attempt, never automatic).
 */
export const TARGET_TRANSITIONS: Record<TargetState, readonly TargetState[]> = {
  draft: ["approved", "cancelled"],
  approved: ["scheduled", "cancelled"],
  scheduled: ["queued", "cancelled"],
  queued: ["transferring", "failed", "cancelled"],
  transferring: ["installing", "failed", "unknown_outcome"],
  installing: ["reconnecting", "failed", "unknown_outcome"],
  reconnecting: ["verifying", "failed", "unknown_outcome"],
  verifying: ["completed", "investigating", "failed"],
  investigating: ["verifying", "queued", "failed", "recovery", "completed"],
  recovery: ["scheduled", "queued", "failed", "cancelled"],
  failed: ["investigating", "recovery", "cancelled"],
  unknown_outcome: ["investigating", "recovery", "failed"],
  completed: [],
  cancelled: [],
};

export function validTargetTransition(from: string, to: string): boolean {
  const f = from as TargetState;
  return (TARGET_TRANSITIONS[f] ?? []).includes(to as TargetState);
}

export const TERMINAL_TARGET_STATES: readonly TargetState[] = ["completed", "cancelled"];
export const isTerminalTarget = (s: string) => TERMINAL_TARGET_STATES.includes(s as TargetState);

/** States that count against concurrency_limit (in-flight physical work). */
export const IN_FLIGHT_TARGET_STATES: readonly TargetState[] = ["queued", "transferring", "installing"];

/**
 * Error strings that indicate possible hardware damage → auto-block the
 * campaign. Conservative: signature/checksum/brick/boot-loop class only.
 */
export const CRITICAL_TARGET_ERROR =
  /critical|brick|boot\s?loop|unrecoverable|signature|checksum|sha-?256|corrupt/i;

export const isCriticalTargetError = (err: string | null | undefined) =>
  !!err && CRITICAL_TARGET_ERROR.test(err);

/** Kinds whose deployment can physically alter device software → MFA elevation. */
export const ELEVATION_REQUIRED_KINDS: readonly ReleaseKind[] = ["firmware", "software"];
export const campaignNeedsElevation = (kind: string) =>
  (ELEVATION_REQUIRED_KINDS as readonly string[]).includes(kind);

/* ── Input schemas ───────────────────────────────────────────────────────── */

/**
 * target_filter shape (stored verbatim in campaign.target_filter jsonb):
 *   { device_ids?, models?, manufacturers?, regions?, venues?, canary_percent? }
 * All fields optional but at least one selection criterion should be present
 * (an empty filter would target the entire eligible fleet — allowed, but the
 * resolved count is always reported back to the caller).
 */
export const targetFilterSchema = z.object({
  device_ids: z.array(z.string().uuid()).max(500).optional(),
  models: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  manufacturers: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  regions: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  venues: z.array(z.string().uuid()).max(200).optional(),
  /** 1–100: keep only the first ceil(N·pct/100) devices of the deterministic
   *  ordering (device_uid asc, id tiebreak) — the canary cohort. */
  canary_percent: z.number().int().min(1).max(100).optional(),
}).strict();
export type TargetFilter = z.infer<typeof targetFilterSchema>;

export const maintenanceWindowSchema = z.object({
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().trim().max(60).optional(),
}).strict().refine(
  (w) => !(w.start && w.end) || Date.parse(w.start) < Date.parse(w.end),
  { message: "maintenance_window.start must be before end" },
);
export type MaintenanceWindow = z.infer<typeof maintenanceWindowSchema>;

export const createCampaignSchema = z.object({
  release_id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  justification: z.string().trim().max(4000).default(""),
  target_filter: targetFilterSchema.default({}),
  maintenance_window: maintenanceWindowSchema.nullish(),
  concurrency_limit: z.number().int().min(1).max(50).default(1),
}).strict();
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

/* ── Target resolution ───────────────────────────────────────────────────── */

/** Devices that may receive updates — same field-deployable set as device-config. */
export const UPDATE_ELIGIBLE_STATUSES: readonly string[] = ["active", "testing", "maintenance"];

const DEVICE_COLS =
  "id,device_uid,manufacturer,model,region,venue_id,status,firmware_version,last_heartbeat_at,last_message_at";

type CandidateDevice = Pick<SystemDeviceRow,
  "id" | "device_uid" | "manufacturer" | "model" | "region" | "venue_id" | "status" | "firmware_version" | "last_heartbeat_at" | "last_message_at">;

export type ExcludedDevice = { device_id: string; device_uid: string | null; reason: string };
export type ResolvedTargets = { devices: CandidateDevice[]; excluded: ExcludedDevice[] };

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const inList = (v: string | null | undefined, list: string[] | undefined) =>
  !list || list.length === 0 || list.some((x) => norm(x) === norm(v));

/**
 * Deterministic ordering for canary selection: device_uid ascending, id as
 * tiebreak. Documented choice — lowest device_uid hash would be equivalent;
 * plain lexicographic order is stable, explainable, and test-friendly.
 */
export function compareDevices(a: { device_uid: string | null; id: string }, b: { device_uid: string | null; id: string }): number {
  const au = a.device_uid ?? "", bu = b.device_uid ?? "";
  if (au !== bu) return au < bu ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Release↔device compatibility: a NULL release manufacturer/model is a wildcard. */
export function releaseCompatibleWithDevice(release: Pick<UpdateReleaseRow, "manufacturer" | "model">, device: CandidateDevice): boolean {
  if (release.manufacturer != null && norm(release.manufacturer) !== norm(device.manufacturer)) return false;
  if (release.model != null && norm(release.model) !== norm(device.model)) return false;
  return true;
}

/**
 * Resolves the device pool for a campaign. Selection criteria are ANDed;
 * incompatible devices and non-eligible statuses are EXCLUDED WITH REASON
 * (never silently dropped). canary_percent keeps the first ceil(N·pct/100) of
 * the deterministically sorted pool; the remainder are excluded with reason
 * 'beyond_canary_percent'.
 */
export async function resolveUpdateTargets(
  db: SupabaseClient,
  release: UpdateReleaseRow,
  filter: TargetFilter,
): Promise<ResolvedTargets> {
  const excluded: ExcludedDevice[] = [];
  const devices: CandidateDevice[] = [];

  let q = db.from("system_devices").select(DEVICE_COLS).limit(2000);
  if (filter.device_ids && filter.device_ids.length > 0) {
    q = q.in("id", filter.device_ids);
  }
  const { data, error } = await q;
  if (error) return { devices: [], excluded: [{ device_id: "*", device_uid: null, reason: `device query failed: ${error.message}` }] };

  const pool = ((data ?? []) as CandidateDevice[])
    .filter((d) => {
      if (!isUuid(d.id)) return false;
      if (filter.device_ids && filter.device_ids.length > 0 && !filter.device_ids.includes(d.id)) return false;
      if (!inList(d.model, filter.models)) return false;
      if (!inList(d.manufacturer, filter.manufacturers)) return false;
      if (!inList(d.region, filter.regions)) return false;
      if (filter.venues && filter.venues.length > 0 && (!d.venue_id || !filter.venues.includes(d.venue_id))) return false;
      return true;
    })
    .sort(compareDevices);

  for (const d of pool) {
    if (!UPDATE_ELIGIBLE_STATUSES.includes(d.status)) {
      excluded.push({ device_id: d.id, device_uid: d.device_uid, reason: `device_status:${d.status}` });
      continue;
    }
    if (!releaseCompatibleWithDevice(release, d)) {
      excluded.push({ device_id: d.id, device_uid: d.device_uid, reason: "incompatible_model_or_manufacturer" });
      continue;
    }
    devices.push(d);
  }

  // Canary cohort: deterministic prefix of the sorted eligible list.
  const pct = filter.canary_percent;
  if (pct != null && pct < 100 && devices.length > 0) {
    const keep = Math.max(1, Math.ceil((devices.length * pct) / 100));
    const dropped = devices.splice(keep);
    for (const d of dropped) {
      excluded.push({ device_id: d.id, device_uid: d.device_uid, reason: "beyond_canary_percent" });
    }
  }

  return { devices, excluded };
}

/* ── Campaign creation ───────────────────────────────────────────────────── */

export type EngineResult<T extends object = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string; pending?: boolean; changeRequestId?: string; code?: string };

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  ({ ok: false as const, status, error, ...extra });

/**
 * Creates a campaign in 'pending_approval' with one 'draft' target row per
 * resolved device. The release MUST exist and be status='approved' — only
 * approved releases may campaign. Excluded devices are recorded on
 * campaign.result.excluded_devices and in the audit detail.
 */
export async function createCampaign(
  db: SupabaseClient,
  actor: SystemActor,
  rawInput: unknown,
): Promise<EngineResult<{ campaign: UpdateCampaignRow; targetCount: number; excluded: ExcludedDevice[] }>> {
  const parsed = createCampaignSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(400, "Invalid campaign input", { code: "invalid_input" });
  }
  const input = parsed.data;

  const { data: relData, error: relErr } = await db.from("kiosk_update_releases")
    .select(UPDATE_RELEASE_SELECT).eq("id", input.release_id).maybeSingle();
  if (relErr) return fail(500, relErr.message);
  const release = relData as UpdateReleaseRow | null;
  if (!release) return fail(404, "Release not found", { code: "release_not_found" });
  if (release.status !== "approved") {
    return fail(409, `Release is '${release.status}' — only approved releases may campaign`, { code: "release_not_approved" });
  }

  const resolved = await resolveUpdateTargets(db, release, input.target_filter);
  if (resolved.excluded.length > 0 && resolved.devices.length === 0 && resolved.excluded[0]?.reason.startsWith("device query failed")) {
    return fail(500, resolved.excluded[0].reason);
  }
  if (resolved.devices.length === 0) {
    return fail(409, "No eligible target devices — check the target filter, device compatibility and canary_percent", {
      code: "no_targets", excluded: resolved.excluded,
    });
  }

  const { data: campData, error: campErr } = await db.from("kiosk_update_campaigns").insert({
    release_id: release.id,
    name: input.name,
    justification: input.justification,
    status: "pending_approval",
    target_filter: input.target_filter,
    maintenance_window: input.maintenance_window ?? null,
    concurrency_limit: input.concurrency_limit,
    created_by: actor.id,
    // result.excluded_devices preserves WHY devices were skipped; later
    // outcome fields are merged alongside it (never overwritten).
    result: {
      excluded_devices: resolved.excluded.slice(0, 200),
      excluded_count: resolved.excluded.length,
      adapter: kioskAdapterName(),
    },
  }).select(CAMPAIGN_SELECT).single();
  if (campErr || !campData) return fail(500, campErr?.message ?? "campaign insert failed");
  const campaign = campData as UpdateCampaignRow;

  const targetRows = resolved.devices.map((d) => ({
    campaign_id: campaign.id,
    device_id: d.id,
    state: "draft",
  }));
  const { error: tgtErr } = await db.from("kiosk_update_targets").insert(targetRows);
  if (tgtErr) {
    // Best-effort rollback of the orphaned campaign row so a retry starts clean.
    try {
      await db.from("kiosk_update_campaigns").delete().eq("id", campaign.id);
    } catch { /* cleanup is best-effort; the audit trail records the failure */ }
    return fail(500, `target insert failed: ${tgtErr.message}`);
  }

  await systemAudit(db, {
    actor, action: "kiosk.update_campaign_created", resource: `kiosk_update_campaign:${campaign.id}`,
    detail: {
      name: campaign.name, release_id: release.id, release_kind: release.kind,
      release_version: release.version, target_count: resolved.devices.length,
      excluded_count: resolved.excluded.length,
      excluded: resolved.excluded.slice(0, 50),
      concurrency_limit: campaign.concurrency_limit,
      canary_percent: input.target_filter.canary_percent ?? null,
    },
  });
  return { ok: true, campaign, targetCount: resolved.devices.length, excluded: resolved.excluded };
}

/* ── Campaign transitions ────────────────────────────────────────────────── */

export async function getUpdateCampaign(db: SupabaseClient, id: string): Promise<UpdateCampaignRow | null> {
  if (!isUuid(id)) return null;
  const { data } = await db.from("kiosk_update_campaigns").select(CAMPAIGN_SELECT).eq("id", id).maybeSingle();
  return (data as UpdateCampaignRow | null) ?? null;
}

export async function getUpdateRelease(db: SupabaseClient, id: string): Promise<UpdateReleaseRow | null> {
  const { data } = await db.from("kiosk_update_releases").select(UPDATE_RELEASE_SELECT).eq("id", id).maybeSingle();
  return (data as UpdateReleaseRow | null) ?? null;
}

export async function listUpdateCampaigns(db: SupabaseClient, limit = 100): Promise<UpdateCampaignRow[]> {
  const { data } = await db.from("kiosk_update_campaigns").select(CAMPAIGN_SELECT)
    .order("created_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 300));
  return (data ?? []) as UpdateCampaignRow[];
}

/** Merges keys into campaign.result without dropping excluded_devices etc. */
async function mergeCampaignResult(db: SupabaseClient, campaignId: string, patch: Record<string, unknown>) {
  const cur = await getUpdateCampaign(db, campaignId);
  const merged = { ...(cur?.result ?? {}), ...patch };
  await db.from("kiosk_update_campaigns").update({ result: merged }).eq("id", campaignId);
  return merged;
}

/**
 * pending_approval → approved. Separation of duties: the approver MUST differ
 * from created_by. Firmware/software campaigns additionally require
 * `opts.elevationOk` (route supplies requireElevation()). High-risk kinds go
 * through assertApprovedOrRequest so breakglass/high-risk mutations still
 * need an approved change request. Approving flips every 'draft' target to
 * 'approved'.
 */
export async function approveCampaign(
  db: SupabaseClient,
  campaignId: string,
  actor: SystemActor,
  opts: { elevationOk?: boolean; justification?: string } = {},
): Promise<EngineResult<{ campaign: UpdateCampaignRow }>> {
  const campaign = await getUpdateCampaign(db, campaignId);
  if (!campaign) return fail(404, "Campaign not found");
  if (campaign.status !== "pending_approval") {
    return fail(409, `Campaign is '${campaign.status}' — only pending_approval campaigns can be approved`);
  }
  if (campaign.created_by && campaign.created_by === actor.id) {
    return fail(403, "Separation of duties: the campaign creator cannot approve their own campaign", { code: "self_approval" });
  }
  const release = await getUpdateRelease(db, campaign.release_id);
  if (!release) return fail(500, "Linked release missing");
  if (campaignNeedsElevation(release.kind) && opts.elevationOk !== true) {
    return fail(403, `Approving a ${release.kind} campaign requires recent step-up (MFA) elevation`, { code: "step_up_required" });
  }

  const risk: ChangeRisk = release.kind === "firmware" ? "high" : release.kind === "software" ? "medium" : "low";
  const approval = await assertApprovedOrRequest(db, actor, {
    action: `kiosk.update_campaign.approve:${campaign.id}`,
    risk,
    justification: opts.justification?.trim() || `Approve update campaign "${campaign.name}" (${release.kind} ${release.version})`,
  });
  if (approval.status === "pending") {
    return fail(202, "Change request created — awaiting approval", { pending: true, changeRequestId: approval.changeRequestId });
  }
  if (approval.status === "error") return fail(500, approval.error);
  if (approval.status === "rejected") return fail(403, "Change request was rejected");

  const now = new Date().toISOString();
  const { data, error } = await db.from("kiosk_update_campaigns").update({
    status: "approved", approved_by: actor.id, approved_at: now,
  }).eq("id", campaign.id).select(CAMPAIGN_SELECT).single();
  if (error || !data) return fail(500, error?.message ?? "update failed");

  // draft → approved for every target (bulk; per-target edges are valid).
  await db.from("kiosk_update_targets").update({ state: "approved" })
    .eq("campaign_id", campaign.id).eq("state", "draft");

  await systemAudit(db, {
    actor, action: "kiosk.update_campaign_approved", resource: `kiosk_update_campaign:${campaign.id}`,
    detail: { name: campaign.name, release_kind: release.kind, release_version: release.version, risk, change_request_id: approval.changeRequestId },
  });
  return { ok: true, campaign: data as UpdateCampaignRow };
}

/** draft → pending_approval (used if a draft campaign ever exists). */
export async function submitCampaign(
  db: SupabaseClient, campaignId: string, actor: SystemActor,
): Promise<EngineResult<{ campaign: UpdateCampaignRow }>> {
  const campaign = await getUpdateCampaign(db, campaignId);
  if (!campaign) return fail(404, "Campaign not found");
  if (!validCampaignTransition(campaign.status, "pending_approval")) {
    return fail(409, `Cannot submit campaign in status '${campaign.status}'`);
  }
  const { data, error } = await db.from("kiosk_update_campaigns")
    .update({ status: "pending_approval" }).eq("id", campaign.id).select(CAMPAIGN_SELECT).single();
  if (error || !data) return fail(500, error?.message ?? "update failed");
  await systemAudit(db, {
    actor, action: "kiosk.update_campaign_submitted", resource: `kiosk_update_campaign:${campaign.id}`,
    detail: { name: campaign.name, from: campaign.status },
  });
  return { ok: true, campaign: data as UpdateCampaignRow };
}

/* ── Activation + dispatch ───────────────────────────────────────────────── */

export type MaintenanceWindowParsed = { start: number | null; end: number | null };

export function parseMaintenanceWindow(raw: unknown): MaintenanceWindowParsed {
  const w = (raw ?? {}) as Record<string, unknown>;
  const start = typeof w.start === "string" ? Date.parse(w.start) : NaN;
  const end = typeof w.end === "string" ? Date.parse(w.end) : NaN;
  return {
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
  };
}

export type ActivateResult = EngineResult<{
  campaign: UpdateCampaignRow;
  dispatched: number;
  dispatches: { target_id: string; device_id: string; outcome: string; detail?: string }[];
}>;

/**
 * approved|scheduled → active, then dispatches up to concurrency_limit targets.
 * Window rules: a future start keeps the campaign 'scheduled' (error returned
 * asking to wait — activation is refused, not silently deferred); a closed
 * window refuses activation. Dispatch NEVER fabricates progress: each attempt
 * records a system_device_commands row and leaves the target 'queued' with an
 * honest result (adapter name + error code when blocked).
 */
export async function activateCampaign(
  db: SupabaseClient,
  campaignId: string,
  actor: SystemActor,
  opts: { elevationOk?: boolean; now?: number; adapter?: GatewayAdapter } = {},
): Promise<ActivateResult> {
  const nowMs = opts.now ?? Date.now();
  const campaign = await getUpdateCampaign(db, campaignId);
  if (!campaign) return fail(404, "Campaign not found");
  if (campaign.status !== "approved" && campaign.status !== "scheduled") {
    return fail(409, `Campaign is '${campaign.status}' — only approved or scheduled campaigns can activate`);
  }

  const win = parseMaintenanceWindow(campaign.maintenance_window);
  if (win.start != null && nowMs < win.start) {
    // Honest deferral: mark scheduled so the UI shows the pending window.
    if (campaign.status === "approved") {
      await db.from("kiosk_update_campaigns").update({ status: "scheduled" }).eq("id", campaign.id);
    }
    return fail(409, `Maintenance window opens at ${new Date(win.start).toISOString()} — campaign is scheduled`, { code: "window_not_open" });
  }
  if (win.end != null && nowMs > win.end) {
    return fail(409, "Maintenance window has closed — activate is refused", { code: "window_closed" });
  }

  const release = await getUpdateRelease(db, campaign.release_id);
  if (!release) return fail(500, "Linked release missing");
  if (release.status !== "approved") {
    return fail(409, `Release is '${release.status}' — de-approved releases cannot activate`, { code: "release_not_approved" });
  }
  if (campaignNeedsElevation(release.kind) && opts.elevationOk !== true) {
    return fail(403, `Activating a ${release.kind} campaign requires recent step-up (MFA) elevation`, { code: "step_up_required" });
  }

  const risk: ChangeRisk = release.kind === "firmware" ? "high" : release.kind === "software" ? "medium" : "low";
  const approval = await assertApprovedOrRequest(db, actor, {
    action: `kiosk.update_campaign.activate:${campaign.id}`,
    risk,
    justification: `Activate update campaign "${campaign.name}" (${release.kind} ${release.version})`,
  });
  if (approval.status === "pending") {
    return fail(202, "Change request created — awaiting approval", { pending: true, changeRequestId: approval.changeRequestId });
  }
  if (approval.status === "error") return fail(500, approval.error);
  if (approval.status === "rejected") return fail(403, "Change request was rejected");

  const now = new Date(nowMs).toISOString();
  const patch: Record<string, unknown> = { status: "active" };
  if (!campaign.started_at) patch.started_at = now;
  const { data, error } = await db.from("kiosk_update_campaigns")
    .update(patch).eq("id", campaign.id).select(CAMPAIGN_SELECT).single();
  if (error || !data) return fail(500, error?.message ?? "update failed");
  const active = data as UpdateCampaignRow;

  await mergeCampaignResult(db, campaign.id, { last_activated_by: actor.id, last_activated_at: now });

  // Dispatch loop — bounded by concurrency_limit in-flight targets.
  const adapter = opts.adapter ?? getGatewayAdapter();
  const results: { target_id: string; device_id: string; outcome: string; detail?: string }[] = [];
  let dispatched = 0;

  for (;;) {
    const inFlight = await countInFlightTargets(db, campaign.id);
    if (inFlight >= campaign.concurrency_limit) break;
    const next = await nextDispatchableTarget(db, campaign.id);
    if (!next) break;
    const r = await dispatchTarget(db, next, active, release, actor, adapter);
    results.push({ target_id: next.id, device_id: next.device_id, outcome: r.outcome, detail: r.detail });
    dispatched += 1;
  }

  await maybeFinalizeCampaign(db, campaign.id, actor);
  const fresh = await getUpdateCampaign(db, campaign.id);

  await systemAudit(db, {
    actor, action: "kiosk.update_campaign_activated", resource: `kiosk_update_campaign:${campaign.id}`,
    detail: {
      name: campaign.name, release_kind: release.kind, release_version: release.version,
      concurrency_limit: campaign.concurrency_limit, dispatched_this_pass: dispatched,
      adapter: adapter.name, adapter_capabilities: adapter.capabilities(),
      change_request_id: approval.changeRequestId,
    },
  });
  return { ok: true, campaign: fresh ?? active, dispatched, dispatches: results };
}

async function countInFlightTargets(db: SupabaseClient, campaignId: string): Promise<number> {
  const { data } = await db.from("kiosk_update_targets").select("id")
    .eq("campaign_id", campaignId).in("state", [...IN_FLIGHT_TARGET_STATES]);
  return (data ?? []).length;
}

async function nextDispatchableTarget(db: SupabaseClient, campaignId: string): Promise<UpdateTargetRow | null> {
  // 'approved' targets are promoted to 'scheduled' first; 'scheduled' are queued.
  const { data: approved } = await db.from("kiosk_update_targets").select(TARGET_SELECT)
    .eq("campaign_id", campaignId).eq("state", "approved")
    .order("created_at", { ascending: true }).limit(1);
  const a = (approved ?? [])[0] as UpdateTargetRow | undefined;
  if (a) {
    await transitionTarget(db, a.id, "scheduled", { id: "system", role: "system" });
    const { data: s } = await db.from("kiosk_update_targets").select(TARGET_SELECT).eq("id", a.id).maybeSingle();
    return (s as UpdateTargetRow | null) ?? null;
  }
  const { data: scheduled } = await db.from("kiosk_update_targets").select(TARGET_SELECT)
    .eq("campaign_id", campaignId).eq("state", "scheduled")
    .order("created_at", { ascending: true }).limit(1);
  return ((scheduled ?? [])[0] as UpdateTargetRow | undefined) ?? null;
}

/**
 * One dispatch attempt for a 'scheduled' target. Records a
 * system_device_commands audit row and moves the target to 'queued' — with
 * EITHER an accepted gateway command_id OR an honest dispatch_error. The
 * target NEVER advances past 'queued' here: 'transferring'/'installing'
 * require device-side evidence that does not exist without a live adapter.
 */
async function dispatchTarget(
  db: SupabaseClient,
  target: UpdateTargetRow,
  campaign: UpdateCampaignRow,
  release: UpdateReleaseRow,
  actor: SystemActor,
  adapter: GatewayAdapter,
): Promise<{ outcome: string; detail?: string }> {
  const commandType =
    release.kind === "firmware" ? "firmware_update"
    : release.kind === "software" ? "software_update"
    : release.kind === "config" ? "config_update"
    : "display_manifest_update";

  const caps = adapter.capabilities();
  const capable =
    (release.kind === "firmware" || release.kind === "software") ? caps.firmwareUpdate
    : release.kind === "config" ? caps.configUpdate
    : false; // no adapter method exists for display_manifest pushes today

  let commandState = "failed";
  let commandResult: Record<string, unknown> = {};
  let gatewayCommandId: string | null = null;
  let dispatchError: string | null = null;

  if (!capable) {
    dispatchError = adapter.name === "blocked"
      ? "adapter_not_configured"
      : `unsupported_capability:${commandType}`;
    commandResult = {
      reason: dispatchError,
      adapter: adapter.name,
      detail: "Update command recorded for audit only — no live hardware path; nothing was dispatched to the device.",
    };
  } else if ((release.kind === "firmware" || release.kind === "software") && (!release.sha256 || !release.signature_key_id)) {
    dispatchError = "release_missing_signature_material";
    commandResult = { reason: dispatchError, adapter: adapter.name, detail: "Approved release lacks sha256/signature material required for a signed update." };
  } else {
    // A certified adapter exists and claims the capability — attempt the push.
    // (Today this branch is unreachable: no registered adapter sets these
    // flags. It is kept honest: the adapter's own result decides.)
    const commandId = `upd-${campaign.id.slice(0, 8)}-${target.id.slice(0, 8)}-a${target.attempt + 1}`;
    try {
      const res = release.kind === "config"
        ? await adapter.updateConfig({
            deviceId: target.device_id, commandId,
            desired: { update_release_id: release.id, update_version: release.version },
          })
        : await adapter.updateFirmware({
            deviceId: target.device_id, commandId,
            version: release.version,
            artifactRef: release.storage_path ?? "",
            sha256: release.sha256 ?? "",
            signature: release.signature_key_id ?? "",
          });
      if (res.ok) {
        commandState = "pending";
        gatewayCommandId = (res.data as { commandId?: string }).commandId ?? commandId;
        commandResult = { dispatched_via: adapter.name, gateway_command_id: gatewayCommandId };
      } else {
        dispatchError = res.error.code;
        commandResult = { reason: res.error.code, adapter: adapter.name, detail: res.error.detail };
      }
    } catch (e) {
      dispatchError = "adapter_error";
      commandResult = { reason: "adapter_error", adapter: adapter.name, detail: e instanceof Error ? e.message : "adapter threw" };
    }
  }

  // Audit-trail command row (command_type is free-text at the DB level).
  const { data: cmd } = await db.from("system_device_commands").insert({
    device_id: target.device_id,
    command_type: commandType,
    payload: {
      update_campaign_id: campaign.id, update_target_id: target.id,
      release_id: release.id, release_kind: release.kind, release_version: release.version,
      attempt: target.attempt + 1,
    },
    state: commandState,
    issued_by: actor.id,
    result: commandResult,
  }).select("id,state").single();

  const targetPatch: Record<string, unknown> = {
    state: "queued",
    state_entered_at: new Date().toISOString(),
    attempt: target.attempt + 1,
    last_error: dispatchError,
    result: {
      ...(target.result ?? {}),
      command_id: (cmd as { id?: string } | null)?.id ?? null,
      gateway_command_id: gatewayCommandId,
      dispatch_error: dispatchError,
      adapter: adapter.name,
      adapter_capabilities: caps,
      dispatched: commandState === "pending",
      release_version: release.version,
    },
  };
  const { error: upErr } = await db.from("kiosk_update_targets")
    .update(targetPatch).eq("id", target.id);
  if (upErr) return { outcome: "error", detail: upErr.message };

  await systemAudit(db, {
    actor, action: "kiosk.update_target_dispatched", resource: `kiosk_update_target:${target.id}`,
    detail: {
      campaign_id: campaign.id, device_id: target.device_id,
      release_kind: release.kind, release_version: release.version,
      attempt: target.attempt + 1, command_state: commandState,
      dispatch_error: dispatchError, adapter: adapter.name,
    },
  });
  return {
    outcome: dispatchError ? "queued_blocked" : "queued",
    detail: dispatchError ?? `command ${(cmd as { id?: string } | null)?.id ?? "?"} recorded`,
  };
}

/* ── Target state machine ────────────────────────────────────────────────── */

/**
 * Moves one target along TARGET_TRANSITIONS. Illegal edges → error (never a
 * silent jump). Entering 'unknown_outcome' or 'failed' with a critical error
 * auto-blocks the parent campaign. Entering 'queued' from a non-queued state
 * increments `attempt` (each queue = one dispatch attempt).
 */
export async function transitionTarget(
  db: SupabaseClient,
  targetId: string,
  to: TargetState,
  actor: SystemActor,
  opts: { error?: string | null; result?: Record<string, unknown>; now?: string } = {},
): Promise<EngineResult<{ target: UpdateTargetRow; campaignBlocked: boolean }>> {
  if (!isUuid(targetId)) return fail(400, "Invalid target id");
  const { data } = await db.from("kiosk_update_targets").select(TARGET_SELECT).eq("id", targetId).maybeSingle();
  const target = data as UpdateTargetRow | null;
  if (!target) return fail(404, "Update target not found");
  if (target.state === to) return fail(409, `Target is already '${to}'`);
  if (!validTargetTransition(target.state, to)) {
    return fail(409, `Illegal target transition ${target.state} → ${to}`);
  }

  const patch: Record<string, unknown> = {
    state: to,
    state_entered_at: opts.now ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (opts.error !== undefined) patch.last_error = opts.error;
  if (opts.result) patch.result = { ...(target.result ?? {}), ...opts.result };
  if (to === "queued" && target.state !== "queued") patch.attempt = target.attempt + 1;
  if (to === "completed") patch.completed_at = opts.now ?? new Date().toISOString();

  const { data: updated, error } = await db.from("kiosk_update_targets")
    .update(patch).eq("id", target.id).select(TARGET_SELECT).single();
  if (error || !updated) return fail(500, error?.message ?? "update failed");
  const next = updated as UpdateTargetRow;

  await systemAudit(db, {
    actor, action: "kiosk.update_target_transition", resource: `kiosk_update_target:${target.id}`,
    detail: {
      campaign_id: target.campaign_id, device_id: target.device_id,
      from: target.state, to, attempt: next.attempt,
      error: opts.error ?? null,
    },
  });

  // SAFETY: unknown_outcome or critical failed → auto-block the campaign.
  const criticalFail = to === "failed" && isCriticalTargetError(opts.error ?? target.last_error);
  let campaignBlocked = false;
  if (to === "unknown_outcome" || criticalFail) {
    const { data: camp } = await db.from("kiosk_update_campaigns")
      .select(CAMPAIGN_SELECT).eq("id", target.campaign_id).maybeSingle();
    const c = camp as UpdateCampaignRow | null;
    if (c && (c.status === "active" || c.status === "paused" || c.status === "scheduled")) {
      await db.from("kiosk_update_campaigns").update({
        status: "blocked",
        result: { ...(c.result ?? {}), blocked_reason: to === "unknown_outcome" ? "target_unknown_outcome" : "target_critical_failure", blocked_target_id: target.id },
      }).eq("id", c.id);
      campaignBlocked = true;
      await systemAudit(db, {
        actor, action: "kiosk.update_campaign_blocked", resource: `kiosk_update_campaign:${c.id}`,
        detail: { reason: to === "unknown_outcome" ? "target_unknown_outcome" : "target_critical_failure", target_id: target.id, device_id: target.device_id },
      });
    }
  }
  return { ok: true, target: next, campaignBlocked };
}

/**
 * Completion gate. A target may reach 'completed' ONLY with verification
 * evidence: the device-reported firmware/software version must equal the
 * release version AND a fresh heartbeat must exist (stored
 * system_devices.last_heartbeat_at within HEARTBEAT_STALE_MIN, or an explicit
 * evidence.heartbeat_at). For config/display_manifest kinds a fresh heartbeat
 * plus optional reported ack suffices (there is no version to compare).
 *
 * - state 'verifying' + valid evidence → 'completed'
 * - state 'verifying' + missing/contradictory evidence → 'investigating'
 * - state 'investigating' + valid evidence → 'completed'
 * - state 'investigating' + still no evidence → stays 'investigating' (honest hold)
 */
export async function verifyTargetCompletion(
  db: SupabaseClient,
  targetId: string,
  actor: SystemActor,
  evidence: { reported_version?: string; heartbeat_at?: string; notes?: string } | null = null,
): Promise<EngineResult<{ target: UpdateTargetRow; verified: boolean; reason?: string }>> {
  if (!isUuid(targetId)) return fail(400, "Invalid target id");
  const { data } = await db.from("kiosk_update_targets").select(TARGET_SELECT).eq("id", targetId).maybeSingle();
  const target = data as UpdateTargetRow | null;
  if (!target) return fail(404, "Update target not found");
  if (target.state !== "verifying" && target.state !== "investigating") {
    return fail(409, `Target is '${target.state}' — verification applies to verifying/investigating targets`);
  }
  const campaign = await getUpdateCampaign(db, target.campaign_id);
  if (!campaign) return fail(500, "Parent campaign missing");
  const release = await getUpdateRelease(db, campaign.release_id);
  if (!release) return fail(500, "Linked release missing");

  // Gather evidence: explicit param > stored device telemetry.
  const device = await getSystemDevice(db, target.device_id);
  const reportedVersion = evidence?.reported_version ?? device?.firmware_version ?? null;
  const heartbeatAt = evidence?.heartbeat_at ?? device?.last_heartbeat_at ?? null;
  const heartbeatMs = heartbeatAt ? Date.parse(heartbeatAt) : NaN;
  const heartbeatFresh = Number.isFinite(heartbeatMs) && (Date.now() - heartbeatMs) <= HEARTBEAT_STALE_MIN * 60_000;

  const versionMatters = release.kind === "firmware" || release.kind === "software";
  const versionOk = !versionMatters || (reportedVersion != null && reportedVersion === release.version);
  const verified = versionOk && heartbeatFresh;

  const verification = {
    reported_version: reportedVersion,
    expected_version: versionMatters ? release.version : null,
    version_match: versionMatters ? reportedVersion === release.version : null,
    heartbeat_at: heartbeatAt,
    heartbeat_fresh: heartbeatFresh,
    heartbeat_stale_minutes: HEARTBEAT_STALE_MIN,
    evidence_source: evidence ? "explicit" : "device_telemetry",
    notes: evidence?.notes?.slice(0, 500) ?? null,
    verified_at: new Date().toISOString(),
  };

  if (verified) {
    const r = await transitionTarget(db, targetId, "completed", actor, { result: { verification } });
    if (!r.ok) return r;
    await systemAudit(db, {
      actor, action: "kiosk.update_target_verified", resource: `kiosk_update_target:${targetId}`,
      detail: { campaign_id: campaign.id, device_id: target.device_id, reported_version: reportedVersion, release_version: release.version },
    });
    return { ok: true, target: r.target, verified: true };
  }

  // Not verified → honest hold at 'investigating'.
  const reason = !heartbeatFresh
    ? "no_fresh_heartbeat"
    : !versionOk
      ? `version_mismatch:reported=${reportedVersion ?? "none"},expected=${release.version}`
      : "insufficient_evidence";
  const mergedResult = { ...(target.result ?? {}), verification };
  if (target.state === "verifying") {
    const r = await transitionTarget(db, targetId, "investigating", actor, { error: reason, result: { verification } });
    if (!r.ok) return r;
    return { ok: true, target: r.target, verified: false, reason };
  }
  // already investigating — refresh stored evidence only (no state change)
  const { data: upd, error } = await db.from("kiosk_update_targets")
    .update({ result: mergedResult, last_error: reason })
    .eq("id", targetId).select(TARGET_SELECT).single();
  if (error || !upd) return fail(500, error?.message ?? "update failed");
  return { ok: true, target: upd as UpdateTargetRow, verified: false, reason };
}

/* ── Pause / resume / cancel ─────────────────────────────────────────────── */

export async function pauseCampaign(
  db: SupabaseClient, campaignId: string, actor: SystemActor, reason?: string,
): Promise<EngineResult<{ campaign: UpdateCampaignRow }>> {
  const campaign = await getUpdateCampaign(db, campaignId);
  if (!campaign) return fail(404, "Campaign not found");
  if (!validCampaignTransition(campaign.status, "paused")) {
    return fail(409, `Cannot pause campaign in status '${campaign.status}'`);
  }
  const { data, error } = await db.from("kiosk_update_campaigns").update({
    status: "paused", pause_reason: reason?.trim().slice(0, 500) || "operator_pause",
  }).eq("id", campaign.id).select(CAMPAIGN_SELECT).single();
  if (error || !data) return fail(500, error?.message ?? "update failed");
  await systemAudit(db, {
    actor, action: "kiosk.update_campaign_paused", resource: `kiosk_update_campaign:${campaignId}`,
    detail: { name: campaign.name, reason: reason ?? null },
  });
  return { ok: true, campaign: data as UpdateCampaignRow };
}

/** paused|blocked-review → active. 'blocked' campaigns CANNOT resume — they must be cancelled. */
export async function resumeCampaign(
  db: SupabaseClient, campaignId: string, actor: SystemActor,
): Promise<EngineResult<{ campaign: UpdateCampaignRow }>> {
  const campaign = await getUpdateCampaign(db, campaignId);
  if (!campaign) return fail(404, "Campaign not found");
  if (campaign.status === "blocked") {
    return fail(409, "Blocked campaigns cannot resume — investigate, then cancel and open a new campaign", { code: "blocked_no_resume" });
  }
  if (!validCampaignTransition(campaign.status, "active")) {
    return fail(409, `Cannot resume campaign in status '${campaign.status}'`);
  }
  const { data, error } = await db.from("kiosk_update_campaigns").update({
    status: "active", pause_reason: null,
  }).eq("id", campaign.id).select(CAMPAIGN_SELECT).single();
  if (error || !data) return fail(500, error?.message ?? "update failed");
  await systemAudit(db, {
    actor, action: "kiosk.update_campaign_resumed", resource: `kiosk_update_campaign:${campaignId}`,
    detail: { name: campaign.name, from: campaign.status },
  });
  return { ok: true, campaign: data as UpdateCampaignRow };
}

/**
 * Cancels a non-terminal campaign: every non-terminal target → 'cancelled'.
 * Terminal targets (completed/failed-investigating etc.) are left untouched —
 * 'failed'/'unknown_outcome'/'investigating'/'recovery' targets are moved to
 * 'cancelled' too ONLY when they have not started physical work? NO — honesty:
 * any target not in a terminal state is cancelled; in-flight states keep their
 * last recorded evidence in result.
 */
export async function cancelCampaign(
  db: SupabaseClient, campaignId: string, actor: SystemActor, reason?: string,
): Promise<EngineResult<{ campaign: UpdateCampaignRow; cancelledTargets: number }>> {
  const campaign = await getUpdateCampaign(db, campaignId);
  if (!campaign) return fail(404, "Campaign not found");
  if (!validCampaignTransition(campaign.status, "cancelled")) {
    return fail(409, `Cannot cancel campaign in status '${campaign.status}'`);
  }
  // Cancel every target that is not completed/cancelled — including
  // failed/investigating/recovery/unknown_outcome (they are unresolved, not
  // successful-terminal). In-flight targets keep their recorded evidence.
  const cancellable = TARGET_STATES.filter((s) => s !== "completed" && s !== "cancelled");
  const { data: cancelled, error: tErr } = await db.from("kiosk_update_targets")
    .update({ state: "cancelled", last_error: reason?.trim().slice(0, 300) || "campaign_cancelled" })
    .eq("campaign_id", campaignId).in("state", [...cancellable])
    .select("id");
  if (tErr) return fail(500, tErr.message);

  const now = new Date().toISOString();
  const { data, error } = await db.from("kiosk_update_campaigns").update({
    status: "cancelled", finished_at: now, pause_reason: null,
  }).eq("id", campaignId).select(CAMPAIGN_SELECT).single();
  if (error || !data) return fail(500, error?.message ?? "update failed");

  const count = Array.isArray(cancelled) ? cancelled.length : 0;
  await mergeCampaignResult(db, campaignId, { cancelled_targets: count, cancel_reason: reason ?? null });
  await systemAudit(db, {
    actor, action: "kiosk.update_campaign_cancelled", resource: `kiosk_update_campaign:${campaignId}`,
    detail: { name: campaign.name, from: campaign.status, cancelled_targets: count, reason: reason ?? null },
  });
  return { ok: true, campaign: data as UpdateCampaignRow, cancelledTargets: count };
}

/* ── Campaign completion sweep ───────────────────────────────────────────── */

/**
 * Marks a campaign 'completed' when every target reached a terminal state
 * (completed/cancelled), or 'failed' when every target failed/cancelled with
 * none completed. Never auto-expands: this only closes the books.
 */
export async function maybeFinalizeCampaign(
  db: SupabaseClient, campaignId: string, actor: SystemActor,
): Promise<{ finalized: boolean; status?: CampaignStatus }> {
  const campaign = await getUpdateCampaign(db, campaignId);
  if (!campaign || campaign.status !== "active") return { finalized: false };
  const { data } = await db.from("kiosk_update_targets").select("state").eq("campaign_id", campaignId);
  const states = ((data ?? []) as { state: TargetState }[]).map((r) => r.state);
  if (states.length === 0) return { finalized: false };
  // 'failed' is a resolved-bad outcome; every other non-terminal state
  // (queued…verifying, investigating, unknown_outcome, recovery) keeps the
  // campaign open until a human resolves it.
  const open = states.filter((s) => s !== "completed" && s !== "cancelled" && s !== "failed");
  if (open.length > 0) return { finalized: false };
  const completed = states.filter((s) => s === "completed").length;
  const cancelled = states.filter((s) => s === "cancelled").length;
  const failedCount = states.length - completed - cancelled;
  const finalStatus: CampaignStatus =
    completed === states.length ? "completed"
    : cancelled === states.length ? "cancelled"
    : completed > 0 ? "completed"   // partial success — outcome counts stay honest
    : "failed";
  const { data: upd } = await db.from("kiosk_update_campaigns").update({
    status: finalStatus, finished_at: new Date().toISOString(),
  }).eq("id", campaignId).select(CAMPAIGN_SELECT).single();
  if (upd) {
    await mergeCampaignResult(db, campaignId, {
      outcome: { completed, failed: failedCount, cancelled, total: states.length, finalized_at: new Date().toISOString() },
    });
    await systemAudit(db, {
      actor, action: "kiosk.update_campaign_finalized", resource: `kiosk_update_campaign:${campaignId}`,
      detail: { name: campaign.name, status: finalStatus, completed, total: states.length },
    });
    return { finalized: true, status: finalStatus };
  }
  return { finalized: false };
}

/* ── Read helpers for panels / API ───────────────────────────────────────── */

export type CampaignWithRelease = {
  campaign: UpdateCampaignRow;
  release: UpdateReleaseRow | null;
  targetCounts: Partial<Record<TargetState, number>>;
};

/** Campaigns + linked release + per-state target counts (panel read model). */
export async function listCampaignsWithMeta(db: SupabaseClient, limit = 100): Promise<CampaignWithRelease[]> {
  const campaigns = await listUpdateCampaigns(db, limit);
  if (campaigns.length === 0) return [];
  const releaseIds = [...new Set(campaigns.map((c) => c.release_id))];
  const { data: rels } = await db.from("kiosk_update_releases").select(UPDATE_RELEASE_SELECT).in("id", releaseIds);
  const relMap = new Map(((rels ?? []) as UpdateReleaseRow[]).map((r) => [r.id, r]));
  const { data: targets } = await db.from("kiosk_update_targets").select("campaign_id,state")
    .in("campaign_id", campaigns.map((c) => c.id));
  const counts = new Map<string, Partial<Record<TargetState, number>>>();
  for (const t of (targets ?? []) as { campaign_id: string; state: TargetState }[]) {
    const m = counts.get(t.campaign_id) ?? {};
    m[t.state] = (m[t.state] ?? 0) + 1;
    counts.set(t.campaign_id, m);
  }
  return campaigns.map((campaign) => ({
    campaign,
    release: relMap.get(campaign.release_id) ?? null,
    targetCounts: counts.get(campaign.id) ?? {},
  }));
}

export type UpdateTargetWithMeta = UpdateTargetRow & {
  device_uid: string | null;
  device_model: string | null;
  campaign_name: string | null;
};

/** Recent targets joined to device uid + campaign name (panel read model). */
export async function listUpdateTargets(db: SupabaseClient, opts: { campaignId?: string; limit?: number } = {}): Promise<UpdateTargetWithMeta[]> {
  let q = db.from("kiosk_update_targets").select(TARGET_SELECT)
    .order("state_entered_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  if (opts.campaignId && isUuid(opts.campaignId)) q = q.eq("campaign_id", opts.campaignId);
  const { data: targets } = await q;
  const rows = (targets ?? []) as UpdateTargetRow[];
  if (rows.length === 0) return [];

  const deviceIds = [...new Set(rows.map((t) => t.device_id))];
  const campaignIds = [...new Set(rows.map((t) => t.campaign_id))];
  const [{ data: devices }, { data: campaigns }] = await Promise.all([
    db.from("system_devices").select("id,device_uid,model").in("id", deviceIds),
    db.from("kiosk_update_campaigns").select("id,name").in("id", campaignIds),
  ]);
  const devMap = new Map(((devices ?? []) as { id: string; device_uid: string | null; model: string | null }[]).map((d) => [d.id, d]));
  const campMap = new Map(((campaigns ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  return rows.map((t) => ({
    ...t,
    device_uid: devMap.get(t.device_id)?.device_uid ?? null,
    device_model: devMap.get(t.device_id)?.model ?? null,
    campaign_name: campMap.get(t.campaign_id) ?? null,
  }));
}

/** Approved releases for the create-campaign form (dropdown source). */
export async function listApprovedReleases(db: SupabaseClient): Promise<UpdateReleaseRow[]> {
  const { data } = await db.from("kiosk_update_releases").select(UPDATE_RELEASE_SELECT)
    .eq("status", "approved").order("created_at", { ascending: false }).limit(200);
  return (data ?? []) as UpdateReleaseRow[];
}

/** sha256 of a device id — kept for future deterministic hashing needs. */
export const deviceHash = (id: string) => createHash("sha256").update(id).digest("hex");
