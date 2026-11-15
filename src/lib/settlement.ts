import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCommissionPct, previousPeriod } from "./ledgers";
import { toCsv } from "./partner-ops";

/**
 * Partner commission settlement — server-only (service client).
 *
 * Money truth: the app NEVER moves money. Staff pay the partner outside the
 * app (ACH/check/etc.) and record the outcome here. Marking a payout "paid"
 * requires the external provider reference so every settled cent is auditable.
 *
 * Lifecycle: scheduled → approved → paid | failed ; scheduled|approved → cancelled.
 * 'paid', 'failed' and 'cancelled' are terminal.
 */

export const PAYOUT_STATUSES = ["scheduled", "approved", "paid", "failed", "cancelled"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const isPayoutStatus = (s: string): s is PayoutStatus => (PAYOUT_STATUSES as readonly string[]).includes(s);

export const PAYOUT_METHODS = ["ach", "check", "other"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
export const isPayoutMethod = (s: string): s is PayoutMethod => (PAYOUT_METHODS as readonly string[]).includes(s);

/** Legal payout moves. 'approved' may still be cancelled (with the approval trail preserved in approved_by/at). */
export const PAYOUT_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  scheduled: ["approved", "cancelled"],
  approved: ["paid", "failed", "cancelled"],
  paid: [],
  failed: [],
  cancelled: [],
};

export const canTransition = (from: PayoutStatus, to: PayoutStatus) => PAYOUT_TRANSITIONS[from]?.includes(to) ?? false;

export type PayoutTransitionInput = {
  /** profiles.id of the staff member performing the transition (approved_by). */
  actorId?: string | null;
  /** External transfer reference — REQUIRED to mark paid. */
  providerReference?: string | null;
  method?: string | null;
  notes?: string | null;
};

export type PayoutPatch = { ok: true; patch: Record<string, unknown> } | { ok: false; error: string };

/**
 * Builds the DB patch for a legal payout transition, or explains why it's illegal.
 * Pure — unit-testable. `now` is injectable.
 */
export function payoutTransitionPatch(from: PayoutStatus, to: PayoutStatus, input: PayoutTransitionInput = {}, now = new Date()): PayoutPatch {
  if (!canTransition(from, to)) return { ok: false, error: `A ${from} payout cannot move to ${to}.` };
  if (input.method != null && input.method !== "" && !isPayoutMethod(input.method)) {
    return { ok: false, error: `Unknown payout method "${input.method}".` };
  }
  const patch: Record<string, unknown> = { status: to };
  const nowIso = now.toISOString();
  if (to === "approved") {
    patch.approved_by = input.actorId ?? null;
    patch.approved_at = nowIso;
  }
  if (to === "paid") {
    const ref = (input.providerReference ?? "").trim();
    // The app never moves money — a paid status without the external reference is meaningless.
    if (!ref) return { ok: false, error: "provider_reference is required to mark a payout paid — record the external transfer reference." };
    patch.provider_reference = ref;
    patch.paid_at = nowIso;
  }
  if (input.method) patch.method = input.method;
  if (input.notes != null && input.notes !== "") patch.notes = input.notes;
  return { ok: true, patch };
}

export type TransitionResult =
  | { ok: true; before: PayoutStatus; after: PayoutStatus }
  | { ok: false; status: number; error: string };

/**
 * Applies a legal payout transition with an optimistic status guard
 * (`.eq("status", before)`), returning before/after for the caller's audit log.
 * Callers own authorization and auditLog — this only enforces lifecycle legality.
 */
export async function transitionPayout(db: SupabaseClient, payoutId: string, to: PayoutStatus, input: PayoutTransitionInput = {}): Promise<TransitionResult> {
  const { data: row } = await db.from("payout_records").select("id,status").eq("id", payoutId).maybeSingle();
  const before = (row as { status?: string } | null)?.status;
  if (!row || !before || !isPayoutStatus(before)) return { ok: false, status: 404, error: "Payout not found." };
  const built = payoutTransitionPatch(before, to, input);
  if (!built.ok) return { ok: false, status: 409, error: built.error };
  const { data: upd, error } = await db
    .from("payout_records")
    .update(built.patch)
    .eq("id", payoutId)
    .eq("status", before)
    .select("id,status")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Couldn't update the payout." };
  if (!upd) return { ok: false, status: 409, error: "Payout changed while updating — refresh and retry." };
  return { ok: true, before, after: (upd as { status: PayoutStatus }).status };
}

/* ─── Settlement board (admin finance view) ─────────────────────────────── */

export type SettlementState = "unbilled" | "accrued" | "scheduled" | "approved" | "paid" | "failed" | "cancelled";

export type SettlementPayout = {
  id: string; status: PayoutStatus; amountCents: number;
  method: string | null; providerReference: string | null;
  approvedBy: string | null; approvedAt: string | null;
  paidAt: string | null; createdAt: string;
};

export type AgreementWindow = {
  pct: number | null;
  signedAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  scope: "venue" | "org";
};

export type SettlementRow = {
  venueId: string;
  venueName: string;
  organizationId: string | null;
  organizationName: string | null;
  period: string; // YYYY-MM
  ledgerId: string | null;
  grossCents: number | null;
  commissionCents: number | null;
  statementPath: string | null;
  agreement: AgreementWindow | null;
  payouts: SettlementPayout[];
  state: SettlementState;
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Reads the private agreement terms: commission_pct plus any effective dating stored in terms. */
export function agreementWindow(agreement: { venue_id?: string | null; signed_at?: string | null; terms?: unknown } | null): AgreementWindow | null {
  if (!agreement) return null;
  const t = agreement.terms && typeof agreement.terms === "object" ? (agreement.terms as Record<string, unknown>) : {};
  return {
    pct: parseCommissionPct(agreement.terms),
    signedAt: str(agreement.signed_at),
    effectiveFrom: str(t.effective_from) ?? str(t.starts_on) ?? str(t.starts_at),
    effectiveTo: str(t.effective_to) ?? str(t.ends_on) ?? str(t.ends_at),
    scope: agreement.venue_id ? "venue" : "org",
  };
}

/**
 * Derived row state. Precedence surfaces the furthest-along money movement:
 * paid > approved > scheduled > failed > cancelled. No ledger → 'unbilled';
 * ledger without payouts → 'accrued'.
 */
export function deriveSettlementState(hasLedger: boolean, payouts: { status: string }[]): SettlementState {
  if (!hasLedger) return "unbilled";
  if (!payouts.length) return "accrued";
  for (const s of ["paid", "approved", "scheduled", "failed", "cancelled"] as const) {
    if (payouts.some((p) => p.status === s)) return s;
  }
  return "accrued";
}

/**
 * Per-venue settlement board for one YYYY-MM period (defaults to the previous
 * calendar month). Every venue appears — 'unbilled' when no ledger exists yet.
 */
export async function loadSettlementBoard(db: SupabaseClient, period = previousPeriod()): Promise<SettlementRow[]> {
  const date = `${period}-01`;
  const [{ data: venueData }, { data: agreementData }] = await Promise.all([
    db.from("venues").select("id,name,organization_id,organizations(name)").limit(2000),
    db.from("partner_agreements").select("organization_id,venue_id,terms,signed_at").order("signed_at", { ascending: false, nullsFirst: false }).limit(2000),
  ]);
  type VenueRow = { id: string; name: string; organization_id: string | null; organizations: { name: string } | { name: string }[] | null };
  type AgreementRow = { organization_id: string; venue_id: string | null; terms: unknown; signed_at: string | null };
  const venues = (venueData ?? []) as unknown as VenueRow[];
  const agreements = (agreementData ?? []) as unknown as AgreementRow[];

  const { data: ledgerData } = await db
    .from("commission_ledgers")
    .select("id,venue_id,period,gross_cents,commission_cents,statement_path")
    .eq("period", date)
    .limit(2000);
  type LedgerRow = { id: string; venue_id: string; period: string; gross_cents: number; commission_cents: number; statement_path: string | null };
  const ledgers = (ledgerData ?? []) as unknown as LedgerRow[];
  const ledgerIds = ledgers.map((l) => l.id);

  const { data: payoutData } = ledgerIds.length
    ? await db
        .from("payout_records")
        .select("id,ledger_id,amount_cents,status,method,provider_reference,approved_by,approved_at,paid_at,created_at")
        .in("ledger_id", ledgerIds)
        .order("created_at", { ascending: false })
        .limit(5000)
    : { data: [] as never[] };
  type PayoutRow = {
    id: string; ledger_id: string; amount_cents: number; status: string;
    method: string | null; provider_reference: string | null;
    approved_by: string | null; approved_at: string | null;
    paid_at: string | null; created_at: string;
  };
  const payoutsByLedger = new Map<string, SettlementPayout[]>();
  for (const p of (payoutData ?? []) as unknown as PayoutRow[]) {
    const list = payoutsByLedger.get(p.ledger_id) ?? [];
    list.push({
      id: p.id, status: isPayoutStatus(p.status) ? p.status : "scheduled",
      amountCents: p.amount_cents, method: p.method, providerReference: p.provider_reference,
      approvedBy: p.approved_by, approvedAt: p.approved_at, paidAt: p.paid_at, createdAt: p.created_at,
    });
    payoutsByLedger.set(p.ledger_id, list);
  }

  const ledgerByVenue = new Map(ledgers.map((l) => [l.venue_id, l]));
  const agreementFor = (v: VenueRow): AgreementWindow | null => {
    // Same precedence as generateLedgers: venue-specific agreement first, then org-wide.
    const ag = agreements.find((a) => a.venue_id === v.id) ?? agreements.find((a) => a.organization_id === v.organization_id && !a.venue_id);
    return agreementWindow(ag ?? null);
  };

  return venues.map((v) => {
    const org = one(v.organizations);
    const ledger = ledgerByVenue.get(v.id) ?? null;
    const payouts = ledger ? (payoutsByLedger.get(ledger.id) ?? []) : [];
    return {
      venueId: v.id,
      venueName: v.name,
      organizationId: v.organization_id,
      organizationName: org?.name ?? null,
      period,
      ledgerId: ledger?.id ?? null,
      grossCents: ledger?.gross_cents ?? null,
      commissionCents: ledger?.commission_cents ?? null,
      statementPath: ledger?.statement_path ?? null,
      agreement: agreementFor(v),
      payouts,
      state: deriveSettlementState(!!ledger, payouts),
    };
  });
}

/* ─── Partner-scoped earnings ───────────────────────────────────────────── */

export type PartnerPayoutRef = {
  id: string; status: PayoutStatus; amountCents: number;
  method: string | null; providerReference: string | null;
  approvedAt: string | null; paidAt: string | null; createdAt: string;
};

export type PartnerEarningsRow = {
  venueId: string;
  venueName: string;
  period: string; // YYYY-MM
  grossCents: number;
  commissionCents: number;
  /** Commission rate from the private agreement terms; null when no rate is on file. */
  pct: number | null;
  paidCents: number;
  /** commission − paid (scheduled/approved/failed amounts are still owed until paid). */
  outstandingCents: number;
  payouts: PartnerPayoutRef[];
};

const firstOfMonthUtc = (monthsAgo: number, now = new Date()) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

/**
 * Org-scoped earnings: one row per venue+ledger period, with payout references.
 * Every query is scoped through venues.organization_id (two-layer like
 * loadOrgReport) — no cross-org data can leak. `months` = how many calendar
 * months back to include (default 6, current month included).
 */
export async function computePartnerEarnings(db: SupabaseClient, orgId: string, months = 6, now = new Date()): Promise<PartnerEarningsRow[]> {
  const { data: venueData } = await db.from("venues").select("id,name").eq("organization_id", orgId).limit(500);
  const venues = ((venueData ?? []) as { id: string; name: string }[]);
  const venueIds = venues.map((v) => v.id);
  const venueName = new Map(venues.map((v) => [v.id, v.name]));
  if (!venueIds.length) return [];

  const since = firstOfMonthUtc(Math.max(0, months - 1), now);
  const [{ data: ledgerData }, { data: agreementData }] = await Promise.all([
    db.from("commission_ledgers").select("id,venue_id,period,gross_cents,commission_cents").in("venue_id", venueIds).gte("period", since).order("period", { ascending: false }).limit(2000),
    db.from("partner_agreements").select("organization_id,venue_id,terms,signed_at").eq("organization_id", orgId).order("signed_at", { ascending: false, nullsFirst: false }).limit(2000),
  ]);
  type LedgerRow = { id: string; venue_id: string; period: string; gross_cents: number; commission_cents: number };
  type AgreementRow = { organization_id: string; venue_id: string | null; terms: unknown; signed_at: string | null };
  const ledgers = (ledgerData ?? []) as unknown as LedgerRow[];
  const agreements = (agreementData ?? []) as unknown as AgreementRow[];

  const ledgerIds = ledgers.map((l) => l.id);
  const { data: payoutData } = ledgerIds.length
    ? await db
        .from("payout_records")
        .select("id,ledger_id,amount_cents,status,method,provider_reference,approved_at,paid_at,created_at")
        .in("ledger_id", ledgerIds)
        .order("created_at", { ascending: false })
        .limit(5000)
    : { data: [] as never[] };
  type PayoutRow = {
    id: string; ledger_id: string; amount_cents: number; status: string;
    method: string | null; provider_reference: string | null;
    approved_at: string | null; paid_at: string | null; created_at: string;
  };
  const payoutsByLedger = new Map<string, PartnerPayoutRef[]>();
  for (const p of (payoutData ?? []) as unknown as PayoutRow[]) {
    const list = payoutsByLedger.get(p.ledger_id) ?? [];
    list.push({
      id: p.id, status: isPayoutStatus(p.status) ? p.status : "scheduled",
      amountCents: p.amount_cents, method: p.method, providerReference: p.provider_reference,
      approvedAt: p.approved_at, paidAt: p.paid_at, createdAt: p.created_at,
    });
    payoutsByLedger.set(p.ledger_id, list);
  }

  return ledgers.map((l) => {
    // Venue-specific agreement first, then the org-wide one (same precedence as ledger generation).
    const ag = agreements.find((a) => a.venue_id === l.venue_id) ?? agreements.find((a) => !a.venue_id);
    const payouts = payoutsByLedger.get(l.id) ?? [];
    const paidCents = payouts.filter((p) => p.status === "paid").reduce((a, p) => a + p.amountCents, 0);
    return {
      venueId: l.venue_id,
      venueName: venueName.get(l.venue_id) ?? "Unknown venue",
      period: l.period.slice(0, 7),
      grossCents: l.gross_cents ?? 0,
      commissionCents: l.commission_cents ?? 0,
      pct: agreementWindow(ag ?? null)?.pct ?? null,
      paidCents,
      outstandingCents: Math.max(0, (l.commission_cents ?? 0) - paidCents),
      payouts,
    };
  });
}

/* ─── CSV statement ─────────────────────────────────────────────────────── */

/**
 * RFC 4180 statement CSV for partner earnings (reuses the formula-injection-safe
 * toCsv/csvCell from partner-ops). One row per venue+period+payout — a period
 * with no payout still appears once with blank payout columns.
 */
export function statementCsv(rows: PartnerEarningsRow[]): string {
  const flat: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (!r.payouts.length) {
      flat.push({
        period: r.period, venue: r.venueName, gross_cents: r.grossCents, commission_cents: r.commissionCents,
        commission_pct: r.pct, paid_cents: r.paidCents, outstanding_cents: r.outstandingCents,
        payout_status: "", payout_amount_cents: "", payout_method: "", payout_reference: "", payout_paid_at: "",
      });
      continue;
    }
    for (const p of r.payouts) {
      flat.push({
        period: r.period, venue: r.venueName, gross_cents: r.grossCents, commission_cents: r.commissionCents,
        commission_pct: r.pct, paid_cents: r.paidCents, outstanding_cents: r.outstandingCents,
        payout_status: p.status, payout_amount_cents: p.amountCents, payout_method: p.method ?? "",
        payout_reference: p.providerReference ?? "", payout_paid_at: p.paidAt ?? "",
      });
    }
  }
  return toCsv(flat);
}
