import type { SupabaseClient } from "@supabase/supabase-js";
import { EQUIPMENT_CATEGORIES, EQUIPMENT_LABELS, isEquipmentCategory } from "./equipment";

/**
 * Equipment agreements (migration 0071) — effective-dated, versioned revenue-share
 * terms per venue + equipment category. Server-only: callers pass the service
 * client. Drafts are created by staff; only an admin may approve (route-enforced)
 * and approval NEVER happens implicitly — a human must call approveAgreement.
 */

export const AGREEMENT_STATUSES = ["draft", "active", "superseded", "terminated"] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];
export const isAgreementStatus = (s: string): s is AgreementStatus => (AGREEMENT_STATUSES as readonly string[]).includes(s);

/** Categories accepted on an agreement: the shared equipment list plus 'combo' (mirrors equipment_models). */
export const AGREEMENT_CATEGORIES = [...EQUIPMENT_CATEGORIES, "combo"] as const;
export const isAgreementCategory = (s: string) => (AGREEMENT_CATEGORIES as readonly string[]).includes(s);

export type AgreementActor = { id: string };

export type EquipmentAgreement = {
  id: string;
  venue_id: string;
  organization_id: string | null;
  equipment_category: string;
  version: number;
  status: AgreementStatus;
  effective_from: string | null;
  effective_to: string | null;
  revenue_share_pct: number | null;
  terms: Record<string, unknown>;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
};

export type AgreementListItem = EquipmentAgreement & {
  venueName: string | null;
  venueCity: string | null;
  venueState: string | null;
  orgName: string | null;
};

export type AgreementResult = { ok: true; agreement: EquipmentAgreement } | { ok: false; error: string };

export type CreateAgreementInput = {
  venue_id: string;
  equipment_category: string;
  revenue_share_pct?: number | null;
  terms?: Record<string, unknown> | null;
  effective_from?: string | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

const asAgreement = (r: Record<string, unknown>): EquipmentAgreement => ({
  id: String(r.id),
  venue_id: String(r.venue_id),
  organization_id: (r.organization_id as string | null) ?? null,
  equipment_category: String(r.equipment_category),
  version: Number(r.version ?? 1),
  status: (isAgreementStatus(String(r.status)) ? r.status : "draft") as AgreementStatus,
  effective_from: (r.effective_from as string | null) ?? null,
  effective_to: (r.effective_to as string | null) ?? null,
  revenue_share_pct: r.revenue_share_pct == null ? null : Number(r.revenue_share_pct),
  terms: (r.terms && typeof r.terms === "object" ? r.terms : {}) as Record<string, unknown>,
  approved_by: (r.approved_by as string | null) ?? null,
  approved_at: (r.approved_at as string | null) ?? null,
  created_by: (r.created_by as string | null) ?? null,
  created_at: String(r.created_at ?? ""),
});

function validateInput(input: CreateAgreementInput): { ok: true; data: CreateAgreementInput } | { ok: false; error: string } {
  if (!input.venue_id || typeof input.venue_id !== "string") return { ok: false, error: "Choose a venue." };
  const cat = input.equipment_category?.trim();
  if (!cat || cat.length > 60 || !isAgreementCategory(cat)) return { ok: false, error: "Choose a valid equipment category." };
  const pct = input.revenue_share_pct;
  if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) return { ok: false, error: "Revenue share must be between 0 and 100." };
  if (input.effective_from != null && input.effective_from !== "" && !DATE_RE.test(input.effective_from)) return { ok: false, error: "Effective date must be YYYY-MM-DD." };
  return { ok: true, data: { ...input, equipment_category: cat } };
}

/**
 * Creates the next draft version for a venue + category. Version = highest
 * existing version + 1, so drafts and history are never overwritten.
 */
export async function createAgreementDraft(
  db: SupabaseClient,
  actor: AgreementActor,
  input: CreateAgreementInput,
): Promise<AgreementResult> {
  const v = validateInput(input);
  if (!v.ok) return v;
  const d = v.data;

  const { data: venue, error: venueErr } = await db
    .from("venues").select("id,organization_id").eq("id", d.venue_id).maybeSingle();
  if (venueErr || !venue) return { ok: false, error: "Unknown venue." };

  const { data: latest } = await db
    .from("equipment_agreements").select("version")
    .eq("venue_id", d.venue_id).eq("equipment_category", d.equipment_category)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  const version = (Number((latest as { version?: number } | null)?.version ?? 0) || 0) + 1;

  const { data, error } = await db.from("equipment_agreements").insert({
    venue_id: d.venue_id,
    organization_id: (venue as { organization_id?: string | null }).organization_id ?? null,
    equipment_category: d.equipment_category,
    version,
    status: "draft",
    effective_from: d.effective_from || null,
    effective_to: null,
    revenue_share_pct: d.revenue_share_pct ?? null,
    terms: d.terms ?? {},
    created_by: actor.id,
  }).select("*").single();
  if (error || !data) return { ok: false, error: "The agreement draft could not be saved." };
  return { ok: true, agreement: asAgreement(data as Record<string, unknown>) };
}

/**
 * Approves a draft: supersedes any currently-active version for the same
 * venue + category, then marks this row active with approver + timestamp.
 * Never auto-approves — the caller (admin route) decides when.
 */
export async function approveAgreement(db: SupabaseClient, actor: AgreementActor, id: string): Promise<AgreementResult> {
  const { data: row, error } = await db.from("equipment_agreements").select("*").eq("id", id).maybeSingle();
  if (error || !row) return { ok: false, error: "Agreement not found." };
  const ag = asAgreement(row as Record<string, unknown>);
  if (ag.status !== "draft") return { ok: false, error: `Only draft agreements can be approved (this one is ${ag.status}).` };

  const now = new Date().toISOString();
  // Supersede other active versions for the same venue + category.
  const { error: supErr } = await db.from("equipment_agreements")
    .update({ status: "superseded" })
    .eq("venue_id", ag.venue_id).eq("equipment_category", ag.equipment_category)
    .eq("status", "active").neq("id", ag.id);
  if (supErr) return { ok: false, error: "The previous agreement could not be superseded." };

  const { data, error: upErr } = await db.from("equipment_agreements").update({
    status: "active",
    approved_by: actor.id,
    approved_at: now,
    effective_from: ag.effective_from ?? today(),
    effective_to: null,
  }).eq("id", ag.id).select("*").single();
  if (upErr || !data) return { ok: false, error: "The agreement could not be approved." };
  return { ok: true, agreement: asAgreement(data as Record<string, unknown>) };
}

/** Terminates an active agreement. Reason (optional) is kept in terms.termination_reason. */
export async function terminateAgreement(db: SupabaseClient, actor: AgreementActor, id: string, reason?: string | null): Promise<AgreementResult> {
  const { data: row, error } = await db.from("equipment_agreements").select("*").eq("id", id).maybeSingle();
  if (error || !row) return { ok: false, error: "Agreement not found." };
  const ag = asAgreement(row as Record<string, unknown>);
  if (ag.status !== "active") return { ok: false, error: `Only active agreements can be terminated (this one is ${ag.status}).` };

  const terms = { ...ag.terms };
  if (reason && reason.trim()) terms.termination_reason = reason.trim().slice(0, 500);
  terms.terminated_by = actor.id;
  terms.terminated_at = new Date().toISOString();

  const { data, error: upErr } = await db.from("equipment_agreements").update({
    status: "terminated",
    effective_to: ag.effective_to ?? today(),
    terms,
  }).eq("id", ag.id).select("*").single();
  if (upErr || !data) return { ok: false, error: "The agreement could not be terminated." };
  return { ok: true, agreement: asAgreement(data as Record<string, unknown>) };
}

export type AgreementFilters = { venue_id?: string; org_id?: string; status?: AgreementStatus | string };

/** Lists agreements newest-first with venue + org display names. Staff/service-role only. */
export async function listAgreements(db: SupabaseClient, filters: AgreementFilters = {}): Promise<AgreementListItem[]> {
  let q = db.from("equipment_agreements")
    .select("*, venue:venues(name,city,state), organization:organizations(name)")
    .order("created_at", { ascending: false }).limit(500);
  if (filters.venue_id) q = q.eq("venue_id", filters.venue_id);
  if (filters.org_id) q = q.eq("organization_id", filters.org_id);
  if (filters.status && isAgreementStatus(filters.status)) q = q.eq("status", filters.status);
  const { data, error } = await q;
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((r) => {
    const venue = (r.venue ?? null) as { name?: string; city?: string; state?: string } | null;
    const org = (r.organization ?? null) as { name?: string } | null;
    return {
      ...asAgreement(r),
      venueName: venue?.name ?? null,
      venueCity: venue?.city ?? null,
      venueState: venue?.state ?? null,
      orgName: org?.name ?? null,
    };
  });
}

/**
 * The currently-effective agreement for a venue + category: status 'active'
 * and today inside [effective_from, effective_to]. Returns null honestly when
 * nothing applies — never guesses.
 */
export async function currentAgreement(db: SupabaseClient, venueId: string, category: string, now = new Date()): Promise<EquipmentAgreement | null> {
  const { data } = await db.from("equipment_agreements").select("*")
    .eq("venue_id", venueId).eq("equipment_category", category).eq("status", "active")
    .order("version", { ascending: false }).limit(10);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(asAgreement);
  const day = now.toISOString().slice(0, 10);
  const hit = rows.find((a) =>
    (!a.effective_from || a.effective_from <= day) &&
    (!a.effective_to || a.effective_to >= day));
  return hit ?? null;
}

/** Category options for selects (shared with the equipment catalog). */
export const agreementCategoryOptions = AGREEMENT_CATEGORIES.map((c) => ({
  value: c,
  label: c === "combo" ? "Combo / mixed" : isEquipmentCategory(c) ? EQUIPMENT_LABELS[c] : c,
}));
