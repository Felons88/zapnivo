import type { SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "./audit";
import { EQUIPMENT_CATEGORIES } from "./equipment";

/**
 * Placement pipeline (migration 0071) — server-only.
 *
 * `placement_stage` on partner_applications is the operational pipeline; the
 * legacy `status` (application_state enum) is kept loosely in sync via
 * legacyStatusForStage/shouldSyncStatus — it never moves backwards out of
 * 'approved'/'installed' because other surfaces (partners page, venue
 * conversion, unit economics) still read it.
 *
 * Assessments are INFORMATIONAL ONLY — nothing here computes or implies
 * approval. Staff decide every stage move explicitly.
 */

/* ─── Stages & transitions ─────────────────────────────────────────────────── */

/** Ordered forward pipeline. 'declined' is a side state, listed last on the board. */
export const PLACEMENT_STAGES = [
  "inquiry",
  "qualified",
  "contacted",
  "site_survey",
  "equipment_recommendation",
  "proposal",
  "negotiation",
  "agreement_pending",
  "approved",
  "sourcing",
  "install_scheduled",
  "installed",
  "active",
] as const;
export type PlacementStage = (typeof PLACEMENT_STAGES)[number] | "declined";

export const PLACEMENT_BOARD_STAGES: readonly PlacementStage[] = [...PLACEMENT_STAGES, "declined"];

export const STAGE_LABELS: Record<PlacementStage, string> = {
  inquiry: "Inquiry",
  qualified: "Qualified",
  contacted: "Contacted",
  site_survey: "Site survey",
  equipment_recommendation: "Equipment rec",
  proposal: "Proposal",
  negotiation: "Negotiation",
  agreement_pending: "Agreement pending",
  approved: "Approved",
  sourcing: "Sourcing",
  install_scheduled: "Install scheduled",
  installed: "Installed",
  active: "Active",
  declined: "Declined",
};

export const isPlacementStage = (v: unknown): v is PlacementStage =>
  typeof v === "string" && (PLACEMENT_BOARD_STAGES as readonly string[]).includes(v);

const stageIndex = (s: PlacementStage): number => PLACEMENT_STAGES.indexOf(s as (typeof PLACEMENT_STAGES)[number]);
/** 'declined' sorts after every pipeline stage for index math. */
const orderIndex = (s: PlacementStage): number => (s === "declined" ? PLACEMENT_STAGES.length : stageIndex(s));

/** Stages before 'approved' — the only place a decline is a pipeline decision. */
export const PRE_APPROVAL_STAGE = "approved" as const;
export const isPreApprovalStage = (s: PlacementStage): boolean => orderIndex(s) < orderIndex(PRE_APPROVAL_STAGE);

/** 'active' is terminal: a live placement is a partner relationship, not a pipeline card. */
export const TERMINAL_STAGES: readonly PlacementStage[] = ["active"];

/**
 * Legal moves (linear pipeline):
 *  - forward exactly one stage or backward exactly one stage — no skipping,
 *    so every transition is deliberate and the audit trail stays granular;
 *  - 'declined' only from pre-approval stages (post-approval exits are contract
 *    conversations, not a board move);
 *  - 'declined' reopens to 'inquiry' only (a fresh pipeline, not a rewind);
 *  - 'active' is terminal — no moves out.
 * Moving INTO 'declined' or 'active' clears follow_up_at (nothing left to chase).
 */
export function canTransition(from: PlacementStage, to: PlacementStage): boolean {
  if (from === to) return false;
  if (from === "declined") return to === "inquiry";
  if (TERMINAL_STAGES.includes(from)) return false;
  if (to === "declined") return isPreApprovalStage(from);
  const fi = orderIndex(from);
  const ti = orderIndex(to);
  return ti === fi + 1 || ti === fi - 1;
}

export function legalMoves(from: PlacementStage): PlacementStage[] {
  return PLACEMENT_BOARD_STAGES.filter((s) => canTransition(from, s));
}

/* ─── Legacy status sync ───────────────────────────────────────────────────── */

/** Maps a placement stage onto the legacy application_state enum, honestly. */
export function legacyStatusForStage(stage: PlacementStage): "new" | "reviewed" | "consultation" | "approved" | "declined" | "installed" {
  switch (stage) {
    case "inquiry": return "new";
    case "qualified":
    case "contacted":
    case "site_survey":
    case "equipment_recommendation": return "reviewed";
    case "proposal":
    case "negotiation":
    case "agreement_pending": return "consultation";
    case "approved":
    case "sourcing":
    case "install_scheduled": return "approved";
    case "installed":
    case "active": return "installed";
    case "declined": return "declined";
  }
}

type LegacyStatus = ReturnType<typeof legacyStatusForStage>;
const STATUS_RANK: Record<LegacyStatus, number> = { new: 0, reviewed: 1, consultation: 2, approved: 3, installed: 4, declined: -1 };

/**
 * Whether the legacy `status` column should be overwritten for a stage move.
 * Never drags 'approved'/'installed' backwards to an earlier review state;
 * 'declined' always writes, and a declined row reopens cleanly.
 */
export function shouldSyncStatus(current: string, next: LegacyStatus): boolean {
  if (next === "declined") return true;
  if (current === "declined") return true;
  const cur = STATUS_RANK[current as LegacyStatus];
  if (cur === undefined) return true; // unknown legacy value — adopt the honest mapping
  return STATUS_RANK[next] >= cur;
}

/* ─── Time helpers ─────────────────────────────────────────────────────────── */

export type FollowUpState = "none" | "overdue" | "today" | "upcoming";

/** 'overdue' = follow-up timestamp is in the past. Terminal stages never report overdue. */
export function followUpState(followUpAt: string | null | undefined, now: Date, stage?: PlacementStage): FollowUpState {
  if (!followUpAt) return "none";
  if (stage && (stage === "active" || stage === "declined")) return "none";
  const t = Date.parse(followUpAt);
  if (!Number.isFinite(t)) return "none";
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t < dayStart) return "overdue";
  if (t < dayStart + 86400_000) return "today";
  return "upcoming";
}

export const isFollowUpOverdue = (followUpAt: string | null | undefined, now: Date, stage?: PlacementStage) =>
  followUpState(followUpAt, now, stage) === "overdue";

/** Whole days a card has sat in its current stage. */
export function daysInStage(enteredAt: string | null | undefined, now: Date): number {
  if (!enteredAt) return 0;
  const t = Date.parse(enteredAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86400_000));
}

/* ─── Board ────────────────────────────────────────────────────────────────── */

export type PlacementCard = {
  id: string;
  businessName: string;
  contactName: string;
  email: string;
  phone: string | null;
  venueType: string;
  city: string;
  state: string;
  productInterest: string | null;
  status: string;
  stage: PlacementStage;
  assignedTo: string | null;
  assigneeName: string | null;
  followUpAt: string | null;
  nextAction: string | null;
  createdAt: string;
  stageEnteredAt: string;
  lastActivityAt: string | null;
  hasAssessment: boolean;
  daysInStage: number;
  followUpOverdue: boolean;
};

export type PlacementColumn = { stage: PlacementStage; label: string; cards: PlacementCard[] };

const APP_SELECT = "id,business_name,contact_name,email,phone,venue_type,city,state,product_interest,status,placement_stage,assigned_to,follow_up_at,next_action,created_at";

type AppRow = {
  id: string; business_name: string; contact_name: string; email: string; phone: string | null;
  venue_type: string; city: string; state: string; product_interest: string | null;
  status: string; placement_stage: string | null; assigned_to: string | null;
  follow_up_at: string | null; next_action: string | null; created_at: string;
};

/**
 * Kanban board data: every application with its stage, assignee, follow-up,
 * last activity and assessment presence, grouped by stage.
 * Staff-only payload — fields mirror what /admin/partners already shows.
 */
export async function loadPlacementBoard(db: SupabaseClient, now = new Date()): Promise<PlacementColumn[]> {
  const [appsRes, actsRes, assessRes] = await Promise.all([
    db.from("partner_applications").select(APP_SELECT).order("created_at", { ascending: false }).limit(500),
    db.from("placement_activities").select("application_id,kind,created_at").order("created_at", { ascending: false }).limit(5000),
    db.from("venue_assessments").select("application_id").limit(2000),
  ]);

  const apps = ((appsRes.data ?? []) as unknown as AppRow[]).map((a) => ({
    ...a,
    placement_stage: isPlacementStage(a.placement_stage) ? a.placement_stage : "inquiry",
  }));

  // Latest activity per application + latest stage_change (activities are desc-sorted).
  const lastActivity = new Map<string, string>();
  const stageEntered = new Map<string, string>();
  for (const act of (actsRes.data ?? []) as { application_id: string; kind: string; created_at: string }[]) {
    if (!lastActivity.has(act.application_id)) lastActivity.set(act.application_id, act.created_at);
    if (act.kind === "stage_change" && !stageEntered.has(act.application_id)) stageEntered.set(act.application_id, act.created_at);
  }
  const assessed = new Set(((assessRes.data ?? []) as { application_id: string | null }[]).map((r) => r.application_id).filter((x): x is string => !!x));

  const assigneeIds = [...new Set(apps.map((a) => a.assigned_to).filter((x): x is string => !!x))];
  const staff = assigneeIds.length
    ? ((await db.from("profiles").select("id,full_name,email").in("id", assigneeIds)).data ?? []) as { id: string; full_name: string | null; email: string }[]
    : [];
  const staffName = new Map(staff.map((p) => [p.id, p.full_name?.trim() || p.email]));

  const columns = new Map<PlacementStage, PlacementCard[]>(PLACEMENT_BOARD_STAGES.map((s) => [s, []]));
  for (const a of apps) {
    const stage = a.placement_stage;
    const enteredAt = stageEntered.get(a.id) ?? a.created_at;
    const card: PlacementCard = {
      id: a.id,
      businessName: a.business_name,
      contactName: a.contact_name,
      email: a.email,
      phone: a.phone,
      venueType: a.venue_type,
      city: a.city,
      state: a.state,
      productInterest: a.product_interest,
      status: a.status,
      stage,
      assignedTo: a.assigned_to,
      assigneeName: a.assigned_to ? staffName.get(a.assigned_to) ?? null : null,
      followUpAt: a.follow_up_at,
      nextAction: a.next_action,
      createdAt: a.created_at,
      stageEnteredAt: enteredAt,
      lastActivityAt: lastActivity.get(a.id) ?? null,
      hasAssessment: assessed.has(a.id),
      daysInStage: daysInStage(enteredAt, now),
      followUpOverdue: isFollowUpOverdue(a.follow_up_at, now, stage),
    };
    columns.get(stage)!.push(card);
  }
  return PLACEMENT_BOARD_STAGES.map((stage) => ({ stage, label: STAGE_LABELS[stage], cards: columns.get(stage)! }));
}

/* ─── Mutations ────────────────────────────────────────────────────────────── */

export const ACTIVITY_KINDS = ["note", "stage_change", "call", "email", "meeting", "document"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const isActivityKind = (v: unknown): v is ActivityKind => typeof v === "string" && (ACTIVITY_KINDS as readonly string[]).includes(v);

export type PlacementResult = { ok: true } | { ok: false; error: string };

/** Append a timeline entry. Every call is audit-logged. */
export async function addActivity(db: SupabaseClient, actor: string | null, applicationId: string, kind: ActivityKind, body?: string | null): Promise<PlacementResult> {
  const { error } = await db.from("placement_activities").insert({
    application_id: applicationId, actor, kind, body: body?.trim() || null,
  });
  if (error) return { ok: false, error: "The activity could not be saved." };
  await auditLog(actor, "placement_activity", "partner_application", applicationId, { kind });
  return { ok: true };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Move an application to a new placement stage. Validates the transition,
 * writes a stage_change activity, keeps legacy status in sync and audits.
 */
export async function moveStage(db: SupabaseClient, actor: string | null, applicationId: string, to: PlacementStage, note?: string | null): Promise<PlacementResult & { from?: PlacementStage }> {
  if (!isPlacementStage(to)) return { ok: false, error: "Unknown stage." };
  const { data: app, error: fetchErr } = await db
    .from("partner_applications")
    .select("id,placement_stage,status,follow_up_at")
    .eq("id", applicationId)
    .maybeSingle();
  if (fetchErr || !app) return { ok: false, error: "Application not found." };
  const row = app as { placement_stage: string | null; status: string };
  const from = isPlacementStage(row.placement_stage) ? row.placement_stage : "inquiry";
  if (!canTransition(from, to)) return { ok: false, error: `Cannot move from ${STAGE_LABELS[from]} to ${STAGE_LABELS[to]}.`, from };

  const patch: Record<string, unknown> = { placement_stage: to };
  const nextStatus = legacyStatusForStage(to);
  if (shouldSyncStatus(row.status, nextStatus)) patch.status = nextStatus;
  // Terminal-ish exits need no follow-up chase.
  if (to === "declined" || TERMINAL_STAGES.includes(to)) patch.follow_up_at = null;

  const { error: updErr } = await db.from("partner_applications").update(patch).eq("id", applicationId);
  if (updErr) return { ok: false, error: "The stage could not be saved." , from };

  const noteText = note?.trim();
  const body = `${STAGE_LABELS[from]} → ${STAGE_LABELS[to]}${noteText ? ` — ${noteText}` : ""}`;
  await db.from("placement_activities").insert({ application_id: applicationId, actor, kind: "stage_change", body });
  await auditLog(actor, "placement_stage_move", "partner_application", applicationId, { from, to, note: noteText ?? null });
  return { ok: true, from };
}

export type PlacementMetaInput = {
  assigned_to?: string | null;
  follow_up_at?: string | null;
  next_action?: string | null;
};

/** Update assignee / follow-up / next action. Assignee must be a staff profile. */
export async function updatePlacementMeta(db: SupabaseClient, actor: string | null, applicationId: string, meta: PlacementMetaInput): Promise<PlacementResult> {
  const patch: Record<string, unknown> = {};

  if ("assigned_to" in meta) {
    const v = meta.assigned_to ?? null;
    if (v !== null) {
      if (!UUID_RE.test(v)) return { ok: false, error: "Choose a valid assignee." };
      const { data: prof } = await db.from("profiles").select("id,role").eq("id", v).maybeSingle();
      if (!prof || !["admin", "staff"].includes((prof as { role: string }).role)) {
        return { ok: false, error: "Assignee must be a staff account." };
      }
    }
    patch.assigned_to = v;
  }

  if ("follow_up_at" in meta) {
    const v = meta.follow_up_at ?? null;
    if (v !== null && !Number.isFinite(Date.parse(v))) return { ok: false, error: "Enter a valid follow-up date." };
    patch.follow_up_at = v;
  }

  if ("next_action" in meta) {
    const v = meta.next_action?.trim() || null;
    if (v && v.length > 500) return { ok: false, error: "Next action is too long." };
    patch.next_action = v;
  }

  if (!Object.keys(patch).length) return { ok: false, error: "Nothing to update." };

  const { error } = await db.from("partner_applications").update(patch).eq("id", applicationId);
  if (error) return { ok: false, error: "Placement details could not be saved." };
  await auditLog(actor, "placement_meta", "partner_application", applicationId, patch as Record<string, unknown>);
  return { ok: true };
}

/* ─── Venue assessments (informational only — never auto-approve) ──────────── */

export const ASSESSMENT_FIELDS = [
  "traffic_estimate",
  "electrical_availability",
  "floor_space",
  "accessibility",
  "indoor_outdoor",
  "product_preferences",
  "maintenance_access",
  "equipment_category",
  "constraints",
  "notes",
] as const;
export type AssessmentField = (typeof ASSESSMENT_FIELDS)[number];

const ASSESSMENT_MAX = 1000;
/** venue_assessments.equipment_category accepts the equipment catalog categories plus 'combo' models. */
export const ASSESSMENT_EQUIPMENT_CATEGORIES = [...EQUIPMENT_CATEGORIES, "combo"] as const;

export type AssessmentInput = {
  application_id: string;
  venue_id?: string | null;
} & Partial<Record<AssessmentField, string | null>>;

export type SanitizedAssessment = {
  application_id: string;
  venue_id: string | null;
} & Record<AssessmentField, string | null>;

/**
 * Validates + normalizes an assessment payload. Every field is short free text;
 * empty strings become null. Returns { ok:false } on any violation — callers
 * must not persist partial input.
 */
export function validateAssessmentInput(input: unknown): { ok: true; value: SanitizedAssessment } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Missing assessment." };
  const raw = input as Record<string, unknown>;
  const application_id = typeof raw.application_id === "string" ? raw.application_id.trim() : "";
  if (!UUID_RE.test(application_id)) return { ok: false, error: "Unknown application." };
  const venue_id = raw.venue_id == null || raw.venue_id === "" ? null : String(raw.venue_id).trim();
  if (venue_id !== null && !UUID_RE.test(venue_id)) return { ok: false, error: "Unknown venue." };

  const value = { application_id, venue_id } as SanitizedAssessment;
  for (const f of ASSESSMENT_FIELDS) value[f] = null;
  for (const f of ASSESSMENT_FIELDS) {
    const v = raw[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return { ok: false, error: `${f} must be text.` };
    const t = v.trim();
    if (t.length > ASSESSMENT_MAX) return { ok: false, error: `${f} is too long (max ${ASSESSMENT_MAX} characters).` };
    value[f] = t || null;
  }
  if (value.equipment_category && !(ASSESSMENT_EQUIPMENT_CATEGORIES as readonly string[]).includes(value.equipment_category)) {
    return { ok: false, error: "Unknown equipment category." };
  }
  return { ok: true, value };
}

/**
 * Save (insert-or-update) the assessment for an application. One assessment per
 * application is the working model; a second row only appears via venue_id.
 * Informational only — saving an assessment changes NO pipeline state.
 */
export async function saveAssessment(db: SupabaseClient, actor: string | null, input: AssessmentInput): Promise<PlacementResult & { id?: string }> {
  const p = validateAssessmentInput(input);
  if (!p.ok) return { ok: false, error: p.error };
  const v = p.value;

  const { data: app } = await db.from("partner_applications").select("id").eq("id", v.application_id).maybeSingle();
  if (!app) return { ok: false, error: "Application not found." };

  const fields = Object.fromEntries(ASSESSMENT_FIELDS.map((f) => [f, v[f]]));
  const { data: existing } = await db
    .from("venue_assessments")
    .select("id")
    .eq("application_id", v.application_id)
    .order("assessed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    const { error } = await db.from("venue_assessments").update({ ...fields, venue_id: v.venue_id, assessed_by: actor, assessed_at: new Date().toISOString() }).eq("id", (existing as { id: string }).id);
    if (error) return { ok: false, error: "The assessment could not be saved." };
    await auditLog(actor, "save_assessment", "venue_assessment", (existing as { id: string }).id, { application_id: v.application_id });
    return { ok: true, id: (existing as { id: string }).id };
  }
  const { data: ins, error } = await db.from("venue_assessments").insert({ ...fields, application_id: v.application_id, venue_id: v.venue_id, assessed_by: actor }).select("id").single();
  if (error || !ins) return { ok: false, error: "The assessment could not be saved." };
  await auditLog(actor, "save_assessment", "venue_assessment", (ins as { id: string }).id, { application_id: v.application_id });
  return { ok: true, id: (ins as { id: string }).id };
}

export type VenueAssessment = {
  id: string; application_id: string | null; venue_id: string | null;
  assessed_by: string | null; assessed_at: string;
} & Record<AssessmentField, string | null>;

/** Latest assessment for an application, or null. */
export async function loadAssessment(db: SupabaseClient, applicationId: string): Promise<VenueAssessment | null> {
  const { data } = await db
    .from("venue_assessments")
    .select("*")
    .eq("application_id", applicationId)
    .order("assessed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as VenueAssessment | null) ?? null;
}

/** Full timeline for the detail page (newest first). */
export async function loadActivities(db: SupabaseClient, applicationId: string, limit = 100) {
  const { data } = await db
    .from("placement_activities")
    .select("id,actor,kind,body,created_at,profiles(email,full_name)")
    .eq("application_id", applicationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as unknown as { id: string; actor: string | null; kind: ActivityKind; body: string | null; created_at: string; profiles: { email: string; full_name: string | null } | { email: string; full_name: string | null }[] | null }[];
}
