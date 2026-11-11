import type { SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "../audit";
import { fmt } from "../pricing";
import { allRiskSignals, type SignalGift, type SignalPayment, type SignalRefundRequest } from "./risk-signals";

/**
 * Financial investigations — service layer.
 *
 * HARD RULE: nothing in this module moves money. `recommend()` produces an advisory
 * dossier + suggestion that always requires a human `decide()`. Refund execution lives
 * exclusively in src/app/api/admin/payments/[id]/refund (staff-only, policy-gated).
 * No agent-facing tool may call decide() — agents may only create/collect/note.
 */

export const FIN_CASE_STATUSES = [
  "new", "collecting_evidence", "investigation", "awaiting_customer", "awaiting_hardware",
  "awaiting_payment", "human_review", "approved_action", "denied", "escalated",
  "resolved", "reopened",
] as const;
export type FinCaseStatus = (typeof FIN_CASE_STATUSES)[number];

export const FIN_CASE_TYPES = [
  "duplicate_charge", "failed_dispense", "missing_telemetry", "credit_issue",
  "refund_dispute", "fraud_review", "general",
] as const;
export type FinCaseType = (typeof FIN_CASE_TYPES)[number];

export const FIN_SEVERITIES = ["low", "normal", "high", "critical"] as const;
export type FinSeverity = (typeof FIN_SEVERITIES)[number];

/** Legal status moves. `decide()` handles approved_action/denied itself; this map is for setStatus(). */
const TRANSITIONS: Record<FinCaseStatus, readonly FinCaseStatus[]> = {
  new: ["collecting_evidence", "investigation", "escalated"],
  collecting_evidence: ["investigation", "new", "escalated"],
  investigation: ["awaiting_customer", "awaiting_hardware", "awaiting_payment", "human_review", "escalated", "resolved"],
  awaiting_customer: ["investigation", "human_review", "escalated"],
  awaiting_hardware: ["investigation", "human_review", "escalated"],
  awaiting_payment: ["investigation", "human_review", "escalated"],
  human_review: ["escalated", "resolved"], // approved_action/denied are set only by decide()
  approved_action: ["resolved", "reopened"],
  denied: ["resolved", "reopened"],
  escalated: ["investigation", "human_review", "resolved"],
  resolved: ["reopened"],
  reopened: ["investigation", "collecting_evidence", "escalated"],
};

export const canTransitionStatus = (from: string, to: string) =>
  from === to || (TRANSITIONS[from as FinCaseStatus] ?? []).includes(to as FinCaseStatus);

export type FinCaseRow = {
  id: string;
  case_type: string;
  status: string;
  severity: string;
  customer_ref: string | null;
  rental_id: string | null;
  payment_id: string | null;
  station_id: string | null;
  claimed_amount_cents: number | null;
  subject: string;
  description: string;
  assigned_to: string | null;
  evidence: EvidenceDossier | Record<string, unknown>;
  recommendation: Recommendation | null;
  decision: string | null;
  decision_rationale: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type FinCaseEventRow = {
  id: number;
  case_id: string;
  actor: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
};

/* ── Evidence dossier types ─────────────────────────────────────────────────── */

export type EvidenceFact = {
  /** Always `table:id` (or `table:column:value` for aggregates) so every claim is traceable. */
  ref: string;
  summary: string;
  at?: string | null;
  tone?: "info" | "warn" | "bad";
};

export type MissingRecord = { ref: string | null; description: string };

export type EvidenceDossier = {
  collected_at: string;
  verified_facts: EvidenceFact[];
  customer_statements: EvidenceFact[];
  system_observations: EvidenceFact[];
  missing_records: MissingRecord[];
  conflicts: EvidenceFact[];
  policy_notes: string[];
};

/* ── Raw rows the dossier is assembled from (what collectEvidence fetches) ──── */

export type RentalRow = {
  id: string; reference?: string | null; state: string;
  kiosk_id?: string | null; return_kiosk_id?: string | null;
  renter_profile?: string | null; customer_id?: string | null;
  power_bank_id?: string | null; pricing_version?: string | null;
  bank_count?: number | null; promo_code?: string | null;
  started_at?: string | null; dispensed_at?: string | null; returned_at?: string | null;
  non_return_deadline?: string | null; created_at?: string | null;
  return_disputed?: boolean | null; accrued_charge_cents?: number | null;
  non_return_fee_status?: string | null;
};

export type PaymentRow = {
  id: string; rental_id?: string | null; state: string;
  amount_authorized_cents?: number | null; amount_captured_cents?: number | null;
  amount_refunded_cents?: number | null; credit_cents?: number | null;
  discount_cents?: number | null; tax_cents?: number | null;
  stripe_payment_intent_id?: string | null; stripe_checkout_session_id?: string | null;
  receipt_email?: string | null; failure_code?: string | null;
  created_at?: string | null; captured_at?: string | null;
};

export type LedgerRow = {
  id: string; rental_id?: string | null; kind: string; amount_cents: number;
  stripe_payment_intent_id?: string | null; stripe_charge_id?: string | null;
  status: string; idempotency_key?: string | null;
  metadata?: Record<string, unknown> | null; created_at?: string | null;
};

export type EntitlementEventRow = {
  id: number; grant_id?: string | null; profile_id?: string | null;
  event: string; delta: number; balance_after?: number | null;
  ref_type?: string | null; ref_id?: string | null; actor?: string | null;
  note?: string | null; created_at?: string | null;
};

export type SponsoredRow = {
  id: string; campaign_id?: string | null; rental_id?: string | null;
  customer_ref?: string | null; minutes_covered?: number | null;
  status?: string | null; created_at?: string | null;
};

export type KioskEventRow = {
  id: number; kiosk_id?: string | null; type?: string | null;
  result?: string | null; payload?: Record<string, unknown> | null;
  occurred_at?: string | null; received_at?: string | null; processed_at?: string | null;
};

export type DeviceEventRow = {
  id: number; kiosk_id?: string | null; slot_number?: number | null;
  power_bank_id?: string | null; event_type: string;
  payload?: Record<string, unknown> | null; occurred_at?: string | null;
};

export type CommandRow = {
  id: string; kiosk_id?: string | null; command?: string | null; status?: string | null;
  idempotency_key?: string | null; payload?: Record<string, unknown> | null;
  created_at?: string | null; resolved_at?: string | null;
};

export type StripeEventRow = { id: string; type: string; received_at?: string | null };

export type TicketRow = {
  id: string; ticket_number?: string | null; rental_id?: string | null;
  rental_ref?: string | null; email?: string | null; category?: string | null;
  description?: string | null; state?: string | null; created_at?: string | null;
};

export type TicketMessageRow = {
  id: string; ticket_id?: string | null; internal?: boolean | null;
  body?: string | null; created_at?: string | null;
};

export type DossierInput = {
  rental: RentalRow | null;
  payments: PaymentRow[];
  ledger: LedgerRow[];
  entitlementEvents: EntitlementEventRow[];
  sponsored: SponsoredRow[];
  kioskEvents: KioskEventRow[];
  deviceEvents: DeviceEventRow[];
  commands: CommandRow[];
  stripeEvents: StripeEventRow[];
  tickets: TicketRow[];
  ticketMessages: TicketMessageRow[];
  /** Window used to scope kiosk/device telemetry; defaults derived from rental timestamps. */
  windowStart?: string | null;
  windowEnd?: string | null;
  now?: string;
};

const iso = (v?: string | null) => (v ? new Date(v).toISOString() : null);
const money = (cents: number | null | undefined) => (cents == null ? "unknown amount" : fmt(cents));

/* ── Pure dossier assembly ──────────────────────────────────────────────────── */

/**
 * Builds the structured evidence dossier from already-fetched rows.
 * Pure — every rule below is unit-testable without a database.
 */
export function assembleDossier(input: DossierInput): EvidenceDossier {
  const now = input.now ?? new Date().toISOString();
  const verified: EvidenceFact[] = [];
  const observed: EvidenceFact[] = [];
  const missing: MissingRecord[] = [];
  const conflicts: EvidenceFact[] = [];
  const policy: string[] = [];

  const r = input.rental;
  const ref = (t: string, id: string | number) => `${t}:${id}`;

  // ── Rental timeline ──
  if (r) {
    verified.push({ ref: ref("rentals", r.id), summary: `Rental ${r.reference ?? r.id} is in state "${r.state}"`, at: r.created_at ?? null });
    if (r.started_at) verified.push({ ref: ref("rentals", r.id), summary: `Rental started ${iso(r.started_at)}`, at: r.started_at });
    if (r.dispensed_at) verified.push({ ref: ref("rentals", r.id), summary: `Bank dispensed ${iso(r.dispensed_at)}`, at: r.dispensed_at });
    if (r.returned_at) verified.push({ ref: ref("rentals", r.id), summary: `Bank returned ${iso(r.returned_at)}`, at: r.returned_at });
    if (r.pricing_version) verified.push({ ref: ref("rentals", r.id), summary: `Pricing version ${r.pricing_version}, ${r.bank_count ?? 1} bank(s)${r.promo_code ? `, promo ${r.promo_code}` : ""}`, at: null });
    if (r.return_disputed) conflicts.push({ ref: ref("rentals", r.id), summary: "Return was flagged disputed by kiosk telemetry — review before assessing fees", tone: "warn" });
    if (r.non_return_fee_status && r.non_return_fee_status !== "none")
      verified.push({ ref: ref("rentals", r.id), summary: `Non-return fee status: ${r.non_return_fee_status}${r.accrued_charge_cents != null ? ` (${money(r.accrued_charge_cents)})` : ""}`, at: null });
    if (r.customer_id) verified.push({ ref: ref("rentals", r.id), summary: `Customer profile ${r.customer_id}`, at: null });
  } else {
    missing.push({ ref: null, description: "No rental record linked to this case — the transaction cannot be reconstructed from rental state." });
  }

  // ── Payments ──
  const captured = input.payments.filter((p) => ["captured", "partially_refunded", "refunded"].includes(p.state));
  if (input.payments.length === 0 && r) {
    missing.push({ ref: null, description: `No payment rows found for rental ${r.reference ?? r.id}.` });
  }
  for (const p of input.payments) {
    const bits = [
      `payment state "${p.state}"`,
      p.amount_authorized_cents != null ? `authorized ${money(p.amount_authorized_cents)}` : null,
      p.amount_captured_cents != null ? `captured ${money(p.amount_captured_cents)}` : null,
      (p.amount_refunded_cents ?? 0) > 0 ? `refunded ${money(p.amount_refunded_cents)}` : null,
      (p.credit_cents ?? 0) > 0 ? `credit applied ${money(p.credit_cents)}` : null,
      p.stripe_payment_intent_id ? `PI ${p.stripe_payment_intent_id}` : "no Stripe payment intent",
    ].filter(Boolean).join(", ");
    verified.push({ ref: ref("payments", p.id), summary: bits, at: p.captured_at ?? p.created_at ?? null });
    if ((p.amount_captured_cents ?? 0) > 0 && !p.stripe_payment_intent_id)
      missing.push({ ref: ref("payments", p.id), description: "Captured payment has no Stripe payment intent — cannot be refunded or traced via Stripe." });
  }
  if (captured.length > 1)
    conflicts.push({ ref: "payments:rental", summary: `${captured.length} captured payments exist for this rental — possible duplicate charge.`, tone: "bad" });
  if (r?.state === "cancelled" && captured.length > 0)
    conflicts.push({ ref: "payments:cancelled_rental", summary: "Payment(s) captured but the rental is cancelled — charge without confirmed service.", tone: "bad" });

  // ── Billing ledger ──
  const succeededCharges = input.ledger.filter((l) => l.status === "succeeded" && l.amount_cents > 0);
  const refunds = input.ledger.filter((l) => l.kind === "refund" && l.amount_cents < 0);
  for (const l of input.ledger) {
    verified.push({
      ref: ref("billing_ledger", l.id),
      summary: `ledger ${l.kind} ${money(l.amount_cents)} (${l.status})${l.stripe_payment_intent_id ? ` PI ${l.stripe_payment_intent_id}` : ""}`,
      at: l.created_at ?? null,
      tone: l.status === "failed" ? "warn" : "info",
    });
  }
  if (succeededCharges.filter((l) => l.kind === "rental_charge").length > 1)
    conflicts.push({ ref: "billing_ledger:rental", summary: "Multiple succeeded rental_charge ledger entries for this rental — verify whether this is a duplicate capture.", tone: "bad" });

  // ── Entitlement events (credit consumed etc.) ──
  for (const e of input.entitlementEvents) {
    verified.push({
      ref: ref("entitlement_events", e.id),
      summary: `entitlement ${e.event} delta ${e.delta} (${e.ref_type ?? "?"}${e.ref_id ? ` ${e.ref_id}` : ""}) by ${e.actor ?? "system"}`,
      at: e.created_at ?? null,
      tone: e.event === "redeem" ? "info" : "warn",
    });
  }
  const consumedOnCancelled = r?.state === "cancelled" && input.entitlementEvents.some((e) => e.event === "redeem" && (!r.id || e.ref_id === r.id || e.ref_id == null));
  if (consumedOnCancelled)
    conflicts.push({ ref: "entitlement_events:rental", summary: "Entitlement credit was consumed but the rental is cancelled — credit restoration may be owed.", tone: "warn" });

  // ── Sponsored redemptions ──
  for (const s of input.sponsored) {
    verified.push({ ref: ref("sponsored_redemptions", s.id), summary: `sponsored redemption ${s.minutes_covered ?? "?"} min covered (${s.status ?? "applied"})`, at: s.created_at ?? null });
  }

  // ── Kiosk telemetry (return evidence) ──
  const kioskId = r?.kiosk_id ?? r?.return_kiosk_id ?? null;
  const scopedKiosk = kioskId ? input.kioskEvents.filter((e) => e.kiosk_id === kioskId) : input.kioskEvents;
  const scopedDevice = kioskId ? input.deviceEvents.filter((e) => e.kiosk_id === kioskId) : input.deviceEvents;
  const returns = scopedKiosk.filter((e) => e.result === "returned" || e.result === "return_disputed");
  const rejections = scopedKiosk.filter((e) => (e.result ?? "").startsWith("rejected"));
  const hasDispenseEvidence = Boolean(
    r?.dispensed_at ||
    scopedDevice.some((e) => /dispens|unlock|slot/i.test(e.event_type)) ||
    scopedKiosk.some((e) => /dispens/i.test(e.type ?? "")),
  );
  // (returned_at alone does not prove kiosk telemetry exists — the gap is still recorded below.)

  for (const e of returns.slice(0, 20)) {
    verified.push({
      ref: ref("kiosk_events", e.id),
      summary: `kiosk ${e.kiosk_id} verified ${e.result === "return_disputed" ? "DISPUTED " : ""}return${e.occurred_at ? ` at ${iso(e.occurred_at)}` : ""}`,
      at: e.occurred_at ?? e.received_at ?? null,
      tone: e.result === "return_disputed" ? "warn" : "info",
    });
  }
  for (const e of rejections.slice(0, 20)) {
    observed.push({
      ref: ref("kiosk_events", e.id),
      summary: `kiosk rejected ${e.type ?? "event"}: ${e.result}`,
      at: e.occurred_at ?? e.received_at ?? null,
      tone: "warn",
    });
  }
  if (scopedKiosk.length === 0 && scopedDevice.length === 0 && (kioskId || r)) {
    missing.push({ ref: kioskId ? ref("kiosks", kioskId) : null, description: "No kiosk events or device telemetry found for this station in the case window — hardware history is unavailable." });
    observed.push({ ref: "kiosk_events:window", summary: "Telemetry window contains no kiosk events — absence of return evidence may reflect missing telemetry, not customer behaviour.", tone: "warn" });
  }
  if (r && ["returned", "closed", "charged_off", "disputed"].includes(r.state) && returns.length === 0) {
    missing.push({ ref: ref("rentals", r.id), description: "Rental is marked returned/closed but no verified kiosk return event was found in telemetry." });
    policy.push("Missing return telemetry is NEVER counted against the customer — it indicates a hardware/logging gap, not a late return.");
  }
  if (r && ["active", "overdue", "unreturned", "dispense_pending", "payment_authorized", "authorized"].includes(r.state) && !hasDispenseEvidence && !r.dispensed_at) {
    observed.push({ ref: ref("rentals", r.id), summary: "No dispense evidence (no dispensed_at, no unlock/dispense device events) found for a non-terminal rental.", tone: "warn" });
  }

  // ── Device commands ──
  const failedCommands = input.commands.filter((c) => c.status === "failed");
  for (const c of input.commands.slice(0, 20)) {
    observed.push({
      ref: ref("device_commands", c.id),
      summary: `command ${c.command ?? "?"} → ${c.status ?? "queued"}${c.idempotency_key ? ` (${c.idempotency_key})` : ""}`,
      at: c.created_at ?? null,
      tone: c.status === "failed" ? "warn" : "info",
    });
  }
  if (failedCommands.length > 0)
    observed.push({ ref: "device_commands:summary", summary: `${failedCommands.length} failed device command(s) — hardware may not have executed the requested action.`, tone: "warn" });

  // ── Stripe webhook log ──
  for (const s of input.stripeEvents.slice(0, 30)) {
    observed.push({ ref: ref("stripe_events", s.id), summary: `stripe webhook ${s.type} received`, at: s.received_at ?? null });
  }
  if (input.stripeEvents.length === 0 && captured.length > 0)
    missing.push({ ref: "stripe_events", description: "No Stripe webhook events recorded — cannot confirm capture/refund events reached the platform." });

  // ── Support tickets & customer statements ──
  for (const t of input.tickets) {
    observed.push({ ref: ref("support_tickets", t.id), summary: `ticket ${t.ticket_number ?? t.id} (${t.category ?? "?"}, ${t.state ?? "?"})`, at: t.created_at ?? null });
  }
  const statements: EvidenceFact[] = [];
  for (const m of input.ticketMessages) {
    if (m.internal) continue;
    const owner = input.tickets.find((t) => t.id === m.ticket_id);
    statements.push({
      ref: ref("support_messages", m.id),
      summary: `customer statement on ${owner?.ticket_number ?? m.ticket_id ?? "ticket"}: ${truncate(m.body ?? "", 240)}`,
      at: m.created_at ?? null,
    });
  }
  // Customer-provided description on the case-linked tickets counts as a statement too.
  for (const t of input.tickets) {
    if (t.description) statements.push({ ref: ref("support_tickets", t.id), summary: `ticket description: ${truncate(t.description, 240)}`, at: t.created_at ?? null });
  }

  // ── Policy notes (always present, honest) ──
  policy.push("Recommendations are advisory only. A human staff member must approve or deny; refund execution stays in the staff refund route.");
  policy.push("Authorizations/releases are not revenue; only captured amounts are refundable.");
  if (refunds.length > 0)
    policy.push(`${refunds.length} refund ledger entr${refunds.length === 1 ? "y" : "ies"} already exist — any proposal must net against them.`);

  return {
    collected_at: now,
    verified_facts: verified,
    customer_statements: statements,
    system_observations: observed,
    missing_records: missing,
    conflicts,
    policy_notes: policy,
  };
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ── Recommendation engine (pure) ───────────────────────────────────────────── */

export type Recommendation = {
  proposed_refund_cents: number | null;
  confidence: "low" | "medium" | "high";
  reasoning: string[];
  contradicting: string[];
  missing: string[];
  customer_explanation_draft: string;
  credit_restore: { ref: string; units: number; note: string } | null;
  generated_at: string;
};

const CAPTURED_STATES = new Set(["captured", "partially_refunded", "refunded"]);

/**
 * Rule-based recommendation over the SAME rows used for the dossier.
 * Every rule cites record refs in `reasoning`. Never proposes more than the
 * verified refundable remainder, and never approves anything by itself.
 */
export function buildRecommendation(input: DossierInput, dossier: EvidenceDossier): Recommendation {
  const now = input.now ?? new Date().toISOString();
  const reasoning: string[] = [];
  const contradicting: string[] = [];
  const missing = dossier.missing_records.map((m) => m.description);
  let proposed: number | null = null;
  let confidence: Recommendation["confidence"] = "low";
  let creditRestore: Recommendation["credit_restore"] = null;

  const r = input.rental;
  const payments = input.payments;
  const capturedPayments = payments.filter((p) => CAPTURED_STATES.has(p.state) && (p.amount_captured_cents ?? 0) > 0);
  const totalCaptured = capturedPayments.reduce((s, p) => s + (p.amount_captured_cents ?? 0), 0);
  const totalRefunded = payments.reduce((s, p) => s + (p.amount_refunded_cents ?? 0), 0)
    + input.ledger.filter((l) => l.kind === "refund" && l.amount_cents < 0).reduce((s, l) => s + Math.abs(l.amount_cents), 0);
  const refundableRemainder = Math.max(0, totalCaptured - totalRefunded);

  // ── Rule 1: verified duplicate capture ──
  const succeededCharges = input.ledger.filter((l) => l.status === "succeeded" && l.amount_cents > 0 && l.kind !== "adjustment");
  const chargeCount = succeededCharges.length;
  const capturedPaymentCount = capturedPayments.length;
  const duplicateLedger = chargeCount >= 2;
  const duplicatePayments = capturedPaymentCount >= 2;

  if (duplicateLedger || duplicatePayments) {
    // Refundable duplicate = captured money beyond the single largest legitimate capture.
    const amounts = [...capturedPayments.map((p) => p.amount_captured_cents ?? 0), ...succeededCharges.map((l) => l.amount_cents)].sort((a, b) => b - a);
    const largest = amounts[0] ?? 0;
    const dupCents = duplicatePayments && duplicateLedger
      ? Math.max(0, refundableRemainder - largest)
      : duplicatePayments
        ? Math.max(0, capturedPayments.slice(1).reduce((s, p) => s + (p.amount_captured_cents ?? 0) - (p.amount_refunded_cents ?? 0), 0))
        : Math.max(0, succeededCharges.slice(1).reduce((s, l) => s + l.amount_cents, 0));
    const dupAmount = dupCents > 0 ? dupCents : (duplicatePayments ? refundableRemainder : succeededCharges[1]?.amount_cents ?? null);
    if (dupAmount != null && dupAmount > 0) {
      proposed = Math.min(dupAmount, refundableRemainder);
      confidence = duplicatePayments && duplicateLedger ? "high" : "medium";
      reasoning.push(`Duplicate capture verified: ${chargeCount} succeeded charge ledger entr${chargeCount === 1 ? "y" : "ies"} and ${capturedPaymentCount} captured payment(s) for the same rental.`);
      for (const l of succeededCharges) reasoning.push(`  ledger:${l.id} ${l.kind} ${money(l.amount_cents)} status=${l.status}`);
      for (const p of capturedPayments) reasoning.push(`  payments:${p.id} captured ${money(p.amount_captured_cents)} state=${p.state}`);
      reasoning.push(`Proposed refund is capped at the verified refundable remainder (${money(refundableRemainder)}).`);
    } else {
      reasoning.push("Duplicate-looking ledger/payment rows exist but net refundable amount is zero after prior refunds.");
      contradicting.push("Prior refunds or credits already returned the duplicated amount.");
    }
  }

  // ── Rule 2: captured charge with failed/absent dispense ──
  const hasDispense = Boolean(
    r?.dispensed_at ||
    input.deviceEvents.some((e) => /dispens|unlock/i.test(e.event_type)) ||
    input.kioskEvents.some((e) => /dispens/i.test(e.type ?? "")),
  );
  const capturedButCancelled = r?.state === "cancelled" && capturedPayments.length > 0;
  if (capturedButCancelled || (r?.state === "cancelled" && refundableRemainder > 0)) {
    reasoning.push(`Payment captured (${money(totalCaptured)}) but rental state is "cancelled"${hasDispense ? "" : " with no dispense evidence"} — customer likely never received the bank.`);
    if (proposed == null && refundableRemainder > 0) {
      proposed = refundableRemainder;
      confidence = hasDispense ? "medium" : "high";
    } else if (proposed != null) {
      confidence = "high";
    }
    if (!hasDispense) reasoning.push("No dispense evidence found — strengthens the refund case.");
  } else if (capturedPayments.length > 0 && !hasDispense && r && ["authorized", "payment_authorized", "pending_payment"].includes(r.state)) {
    reasoning.push("Charge exists but rental never reached dispense and is still pre-active — verify whether funds were actually captured before acting.");
    missing.push("Dispense/activation evidence for the rental.");
  }

  // ── Rule 3: entitlement consumed on cancelled rental → credit restoration ──
  const consumed = input.entitlementEvents.filter((e) => e.event === "redeem" && r?.state === "cancelled");
  if (consumed.length > 0) {
    const units = consumed.reduce((s, e) => s + Math.abs(e.delta), 0);
    creditRestore = {
      ref: `entitlement_events:${consumed.map((e) => e.id).join(",")}`,
      units,
      note: `Entitlement credit of ${units} unit(s) was consumed on a cancelled rental. Restore via an entitlement adjustment (staff action) — do NOT refund money that was never charged.`,
    };
    reasoning.push(`Entitlement ${creditRestore.units} unit(s) consumed on cancelled rental — recommend credit restoration, not a cash refund.`);
  }

  // ── Rule 4: missing return telemetry is explicitly NOT held against customer ──
  const terminalNoTelemetry = r && ["returned", "closed", "charged_off"].includes(r.state)
    && !input.kioskEvents.some((e) => e.result === "returned" || e.result === "return_disputed");
  if (terminalNoTelemetry) {
    reasoning.push("Missing telemetry for the return — per policy this gap is NOT counted against the customer.");
    contradicting.push("Missing return telemetry (see dossier) — not counted against the customer; cannot be used as evidence of fault.");
  }

  // ── Contradicting evidence ──
  for (const c of dossier.conflicts) if (c.tone === "bad") contradicting.push(`${c.ref}: ${c.summary}`);
  const alreadyRefunded = payments.reduce((s, p) => s + (p.amount_refunded_cents ?? 0), 0);
  if (alreadyRefunded > 0) contradicting.push(`${money(alreadyRefunded)} already refunded on linked payments — proposal nets against this.`);
  if (input.sponsored.length > 0) contradicting.push("Sponsored redemption(s) already covered part of this rental's cost.");
  if (dossier.customer_statements.length === 0) missing.push("No customer statement on file — claims are unverified.");

  // ── Customer-facing draft (honest, no promises of outcome) ──
  const rentalRef = r?.reference ?? r?.id ?? "your rental";
  let draft: string;
  if (proposed != null && proposed > 0) {
    draft = `We reviewed ${rentalRef} and found a verified billing discrepancy of ${money(proposed)}. A staff member is reviewing the case now and will follow up shortly. You do not need to take any action.`;
  } else if (creditRestore) {
    draft = `We reviewed ${rentalRef} and found that account credit was used on a cancelled rental. Our team is restoring the credit — no cash refund is needed. We'll confirm once it's done.`;
  } else {
    draft = `We reviewed ${rentalRef} and are checking the details with our team. We'll follow up as soon as the review is complete.`;
  }

  if (proposed == null && !creditRestore && reasoning.length === 0)
    reasoning.push("No rule matched — manual review required. Do not assume fault on either side.");

  return {
    proposed_refund_cents: proposed,
    confidence: proposed != null || creditRestore ? confidence : "low",
    reasoning,
    contradicting,
    missing,
    customer_explanation_draft: draft,
    credit_restore: creditRestore,
    generated_at: now,
  };
}

/* ── DB-backed service functions ────────────────────────────────────────────── */

export type ServiceError = { ok: false; status: number; error: string };
export type Result<T> = { ok: true; data: T } | ServiceError;
const err = (status: number, error: string): ServiceError => ({ ok: false, status, error });
const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });

const CASE_SELECT = "*";

export async function createCase(
  db: SupabaseClient,
  input: {
    caseType: string; subject: string; description?: string;
    severity?: string; customerRef?: string | null;
    rentalId?: string | null; paymentId?: string | null; stationId?: string | null;
    claimedAmountCents?: number | null; createdBy?: string | null; status?: string;
  },
) {
  const { data, error } = await db.from("fin_cases").insert({
    case_type: input.caseType,
    subject: input.subject.slice(0, 300),
    description: (input.description ?? "").slice(0, 8000),
    severity: input.severity ?? "normal",
    customer_ref: input.customerRef ?? null,
    rental_id: input.rentalId ?? null,
    payment_id: input.paymentId ?? null,
    station_id: input.stationId ?? null,
    claimed_amount_cents: input.claimedAmountCents ?? null,
    created_by: input.createdBy ?? null,
    status: input.status ?? "new",
  }).select(CASE_SELECT).single();
  if (error || !data) return err(500, "Could not create the case.");
  const row = data as FinCaseRow;
  await addCaseEvent(db, row.id, input.createdBy ?? "system", "created", { case_type: row.case_type, subject: row.subject });
  return ok(row);
}

/** Resolve a payment by id, Stripe payment intent, checkout session, or rental reference → case links. */
export async function linkCaseToPayment(
  db: SupabaseClient,
  ref: { paymentId?: string; paymentIntentId?: string; checkoutSessionId?: string; rentalRef?: string },
) {
  let q = db.from("payments").select("id,rental_id,state,amount_captured_cents,amount_refunded_cents,stripe_payment_intent_id,receipt_email");
  if (ref.paymentId) q = q.eq("id", ref.paymentId);
  else if (ref.paymentIntentId) q = q.eq("stripe_payment_intent_id", ref.paymentIntentId);
  else if (ref.checkoutSessionId) q = q.eq("stripe_checkout_session_id", ref.checkoutSessionId);
  else if (ref.rentalRef) {
    const { data: rental } = await db.from("rentals").select("id,kiosk_id,reference").eq("reference", ref.rentalRef.toUpperCase()).maybeSingle();
    const r = rental as { id: string; kiosk_id: string | null; reference: string } | null;
    if (!r) return err(404, "Rental not found.");
    const { data: pays } = await db.from("payments").select("id,rental_id,state,amount_captured_cents,amount_refunded_cents,stripe_payment_intent_id,receipt_email").eq("rental_id", r.id).order("created_at", { ascending: false }).limit(1);
    const p = (pays as { id: string; rental_id: string; state: string; amount_captured_cents: number | null; amount_refunded_cents: number | null; stripe_payment_intent_id: string | null; receipt_email: string | null }[] | null)?.[0];
    if (!p) return ok({ payment: null, rental: r });
    return ok({ payment: p, rental: r });
  } else return err(422, "Provide a payment id, payment intent, checkout session, or rental reference.");
  const { data } = await q.limit(1).maybeSingle();
  const p = data as { id: string; rental_id: string; state: string; amount_captured_cents: number | null; amount_refunded_cents: number | null; stripe_payment_intent_id: string | null; receipt_email: string | null } | null;
  if (!p) return err(404, "Payment not found.");
  const { data: rental } = await db.from("rentals").select("id,kiosk_id,reference").eq("id", p.rental_id).maybeSingle();
  return ok({ payment: p, rental: rental as { id: string; kiosk_id: string | null; reference: string } | null });
}

/**
 * Auto-suggest a case from a helpdesk refund request. Idempotent: returns the existing
 * open case for the same rental if one exists instead of duplicating it.
 */
export async function suggestCaseFromRefundRequest(
  db: SupabaseClient,
  rr: { id: string; rental_ref: string; reason?: string; amount_cents?: number; payment_intent_id?: string | null; requested_by?: string },
  createdBy: string | null,
) {
  const link = await linkCaseToPayment(db, { rentalRef: rr.rental_ref });
  if (!link.ok) return link;
  const { payment, rental } = link.data;
  // Idempotency: one open case per rental.
  const { data: existing } = await db.from("fin_cases").select(CASE_SELECT)
    .eq("rental_id", rental?.id ?? "00000000-0000-0000-0000-000000000000")
    .not("status", "in", '("resolved","denied")').limit(1);
  const ex = (existing as FinCaseRow[] | null)?.[0];
  if (ex) return ok({ case: ex, created: false });
  const reasonLabel = (rr.reason ?? "refund").replace(/_/g, " ");
  return createCase(db, {
    caseType: "refund_dispute",
    subject: `Refund request (${reasonLabel}) — ${rr.rental_ref}`,
    description: `Auto-created from helpdesk refund request ${rr.id}. Requested amount: ${rr.amount_cents != null ? fmt(rr.amount_cents) : "unknown"}. Requested by ${rr.requested_by ?? "customer"}.`,
    severity: (rr.amount_cents ?? 0) >= 5000 ? "high" : "normal",
    customerRef: payment?.receipt_email ?? null,
    rentalId: rental?.id ?? null,
    paymentId: payment?.id ?? null,
    stationId: rental?.kiosk_id ? String(rental.kiosk_id) : null,
    claimedAmountCents: rr.amount_cents ?? null,
    createdBy,
  }).then((r) => (r.ok ? ok({ case: r.data, created: true }) : r));
}

export async function listCases(
  db: SupabaseClient,
  filters: { status?: string; caseType?: string; severity?: string; q?: string; limit?: number } = {},
) {
  let q = db.from("fin_cases").select(CASE_SELECT).order("created_at", { ascending: false }).limit(Math.min(filters.limit ?? 100, 200));
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.caseType) q = q.eq("case_type", filters.caseType);
  if (filters.severity) q = q.eq("severity", filters.severity);
  if (filters.q) {
    const term = filters.q.replace(/[%,()]/g, " ").trim().slice(0, 80);
    if (term) q = q.or(`subject.ilike.%${term}%,customer_ref.ilike.%${term}%,description.ilike.%${term}%`);
  }
  const { data, error } = await q;
  if (error) return err(500, "Could not list cases.");
  return ok((data as FinCaseRow[] | null) ?? []);
}

export async function getCase(db: SupabaseClient, id: string) {
  const { data: c, error } = await db.from("fin_cases").select(CASE_SELECT).eq("id", id).maybeSingle();
  if (error) return err(500, "Could not load the case.");
  if (!c) return err(404, "Case not found.");
  const { data: events } = await db.from("fin_case_events").select("*").eq("case_id", id).order("created_at", { ascending: true });
  return ok({ case: c as FinCaseRow, events: (events as FinCaseEventRow[] | null) ?? [] });
}

export async function addCaseEvent(
  db: SupabaseClient, caseId: string, actor: string | null, action: string, detail?: Record<string, unknown>,
) {
  const { error } = await db.from("fin_case_events").insert({ case_id: caseId, actor: actor ?? "system", action, detail: detail ?? null });
  return !error;
}

async function touch(db: SupabaseClient, id: string, patch: Record<string, unknown>) {
  await db.from("fin_cases").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

/** Fetch every row the dossier needs, assemble it, persist it on the case, and audit the collection. */
export async function collectEvidence(db: SupabaseClient, caseId: string) {
  const got = await getCase(db, caseId);
  if (!got.ok) return got;
  const c = got.data.case;
  const fetched = await fetchDossierInput(db, c);
  if (!fetched.ok) return fetched;
  const dossier = assembleDossier(fetched.data);
  await touch(db, caseId, { evidence: dossier, status: c.status === "new" ? "collecting_evidence" : c.status });
  await addCaseEvent(db, caseId, "system", "evidence_collected", {
    verified: dossier.verified_facts.length,
    statements: dossier.customer_statements.length,
    observations: dossier.system_observations.length,
    missing: dossier.missing_records.length,
    conflicts: dossier.conflicts.length,
  });
  const fresh = await getCase(db, caseId);
  return fresh.ok ? ok({ case: fresh.data.case, dossier }) : fresh;
}

/** Runs the rule engine over freshly collected evidence and stores the advisory recommendation. */
export async function recommend(db: SupabaseClient, caseId: string, actor: string | null = "system") {
  // Re-collect so the recommendation always reflects current rows.
  const collected = await collectEvidence(db, caseId);
  if (!collected.ok) return collected;
  const got = await getCase(db, caseId);
  if (!got.ok) return got;
  const fetched = await fetchDossierInput(db, got.data.case);
  if (!fetched.ok) return fetched;
  const dossier = assembleDossier(fetched.data);
  const rec = buildRecommendation(fetched.data, dossier);
  await touch(db, caseId, { recommendation: rec });
  await addCaseEvent(db, caseId, actor, "recommendation", {
    proposed_refund_cents: rec.proposed_refund_cents,
    confidence: rec.confidence,
    credit_restore: rec.credit_restore != null,
  });
  const fresh = await getCase(db, caseId);
  return fresh.ok ? ok({ case: fresh.data.case, recommendation: rec }) : fresh;
}

/** Human decision — the ONLY path that can mark a case approved/denied. Requires rationale. */
export async function decideCase(
  db: SupabaseClient, caseId: string,
  actor: { id: string; role: "admin" | "staff" }, decision: "approved" | "denied", rationale: string,
) {
  if (!rationale || rationale.trim().length < 5) return err(422, "A rationale of at least 5 characters is required.");
  const got = await getCase(db, caseId);
  if (!got.ok) return got;
  const c = got.data.case;
  const target: FinCaseStatus = decision === "approved" ? "approved_action" : "denied";
  if (!canTransitionStatus(c.status, target)) {
    // Allow deciding directly from most working states even if not explicitly listed.
    if (!["investigation", "human_review", "escalated", "awaiting_customer", "awaiting_hardware", "awaiting_payment", "collecting_evidence", "new", "reopened"].includes(c.status))
      return err(409, `Cannot decide a case in status "${c.status}".`);
  }
  await touch(db, caseId, {
    decision, decision_rationale: rationale.trim().slice(0, 2000),
    decided_by: actor.id, decided_at: new Date().toISOString(), status: target,
  });
  await addCaseEvent(db, caseId, actor.id, "decided", { decision, rationale: rationale.trim().slice(0, 500), role: actor.role });
  await auditLog(actor.id, `fin_case_${decision}`, "fin_case", caseId, { decision, rationale: rationale.trim().slice(0, 300) });
  return getCase(db, caseId);
}

export async function assignCase(db: SupabaseClient, caseId: string, actorId: string, assigneeId: string | null) {
  const got = await getCase(db, caseId);
  if (!got.ok) return got;
  await touch(db, caseId, { assigned_to: assigneeId });
  await addCaseEvent(db, caseId, actorId, "assigned", { assignee: assigneeId });
  await auditLog(actorId, "fin_case_assign", "fin_case", caseId, { assignee: assigneeId });
  return getCase(db, caseId);
}

export async function setCaseStatus(db: SupabaseClient, caseId: string, actorId: string, status: string) {
  if (!FIN_CASE_STATUSES.includes(status as FinCaseStatus)) return err(422, "Unknown status.");
  const got = await getCase(db, caseId);
  if (!got.ok) return got;
  const c = got.data.case;
  if (c.status === "approved_action" || c.status === "denied")
    return err(409, "Decided cases can only move to resolved or reopened.");
  if (!canTransitionStatus(c.status, status)) return err(409, `Illegal transition ${c.status} → ${status}.`);
  await touch(db, caseId, { status });
  await addCaseEvent(db, caseId, actorId, "status", { from: c.status, to: status });
  return getCase(db, caseId);
}

export async function addCaseNote(db: SupabaseClient, caseId: string, actorId: string, note: string) {
  const got = await getCase(db, caseId);
  if (!got.ok) return got;
  await addCaseEvent(db, caseId, actorId, "note", { note: note.slice(0, 2000) });
  return getCase(db, caseId);
}

/* ── Risk signal gathering (DB → pure functions in risk-signals.ts) ─────────── */

/**
 * Collects the rows risk-signals needs for a case and runs the pure detectors.
 * Advisory only — callers display results; nothing auto-acts on them.
 */
export async function caseRiskSignals(db: SupabaseClient, c: FinCaseRow) {
  const paymentsQ = db.from("payments")
    .select("id,state,receipt_email,amount_captured_cents,amount_refunded_cents,failure_code,created_at,rental_id");
  const { data: pays } = c.rental_id
    ? await paymentsQ.eq("rental_id", c.rental_id)
    : c.payment_id ? await paymentsQ.eq("id", c.payment_id) : { data: [] };
  const rows = (pays as SignalPayment[] | null) ?? [];
  const emails = [...new Set(rows.map((p) => p.receipt_email).filter((e): e is string => Boolean(e)))];
  let extra: SignalPayment[] = [];
  if (emails.length) {
    const { data: more } = await paymentsQ.in("receipt_email", emails).limit(100);
    extra = (more as SignalPayment[] | null) ?? [];
  }
  const allPays = [...rows, ...extra];

  let refundReqs: SignalRefundRequest[] = [];
  if (c.rental_id) {
    const { data: rental } = await db.from("rentals").select("reference").eq("id", c.rental_id).maybeSingle();
    const ref = (rental as { reference?: string } | null)?.reference;
    if (ref) {
      const { data: rr } = await db.from("refund_requests").select("id,rental_ref,status,amount_cents,reason,created_at").eq("rental_ref", ref).limit(50);
      refundReqs = (rr as SignalRefundRequest[] | null) ?? [];
    }
  }

  const custEmail = c.customer_ref ?? rows[0]?.receipt_email ?? null;
  let gifts: SignalGift[] = [];
  if (custEmail) {
    const { data: g } = await db.from("gift_credits").select("id,status,attempts,recipient_email,last_attempt_at")
      .or(`purchaser_email.eq.${custEmail},recipient_email.eq.${custEmail}`).limit(50);
    gifts = (g as SignalGift[] | null) ?? [];
  }
  return allRiskSignals({ payments: allPays, refundRequests: refundReqs, gifts });
}

/* ── Internal: fetch raw dossier input (shared by collect + recommend) ───────── */

async function fetchDossierInput(db: SupabaseClient, c: FinCaseRow): Promise<Result<DossierInput>> {
  let rental: RentalRow | null = null;
  let stationId = c.station_id;
  if (c.rental_id) {
    const { data } = await db.from("rentals")
      .select("id,reference,state,kiosk_id,return_kiosk_id,renter_profile,customer_id,power_bank_id,pricing_version,bank_count,promo_code,started_at,dispensed_at,returned_at,non_return_deadline,created_at,return_disputed,accrued_charge_cents,non_return_fee_status")
      .eq("id", c.rental_id).maybeSingle();
    rental = (data as RentalRow | null) ?? null;
    stationId = stationId ?? (rental?.kiosk_id ? String(rental.kiosk_id) : null) ?? (rental?.return_kiosk_id ? String(rental.return_kiosk_id) : null);
  }
  const paymentQ = db.from("payments")
    .select("id,rental_id,state,amount_authorized_cents,amount_captured_cents,amount_refunded_cents,credit_cents,discount_cents,tax_cents,stripe_payment_intent_id,stripe_checkout_session_id,receipt_email,failure_code,created_at,captured_at");
  const { data: payments } = c.payment_id
    ? await paymentQ.eq("id", c.payment_id)
    : c.rental_id ? await paymentQ.eq("rental_id", c.rental_id) : await paymentQ.limit(0);
  const ledgerQ = db.from("billing_ledger")
    .select("id,rental_id,kind,amount_cents,stripe_payment_intent_id,stripe_charge_id,status,idempotency_key,metadata,created_at");
  const { data: ledger } = c.rental_id ? await ledgerQ.eq("rental_id", c.rental_id) : { data: [] };
  const customerId = rental?.customer_id ?? rental?.renter_profile ?? null;
  const entQ = db.from("entitlement_events")
    .select("id,grant_id,profile_id,event,delta,balance_after,ref_type,ref_id,actor,note,created_at");
  let entQuery = entQ;
  if (customerId && c.rental_id) entQuery = entQ.or(`profile_id.eq.${customerId},and(ref_type.eq.rental,ref_id.eq.${c.rental_id})`);
  else if (c.rental_id) entQuery = entQ.eq("ref_id", c.rental_id);
  else if (customerId) entQuery = entQ.eq("profile_id", customerId);
  else entQuery = entQ.limit(0);
  const { data: entEvents } = await entQuery.order("created_at", { ascending: false }).limit(100);
  const { data: sponsored } = c.rental_id
    ? await db.from("sponsored_redemptions").select("id,campaign_id,rental_id,customer_ref,minutes_covered,status,created_at").eq("rental_id", c.rental_id)
    : { data: [] };
  const winStart = rental?.created_at ? new Date(Date.parse(rental.created_at) - 86_400_000).toISOString() : null;
  const winEnd = new Date().toISOString();
  const stationUuid = stationId && /^[0-9a-f-]{36}$/i.test(stationId) ? stationId : null;
  const kioskQ = db.from("kiosk_events").select("id,kiosk_id,type,result,payload,occurred_at,received_at,processed_at");
  const devQ = db.from("device_events").select("id,kiosk_id,slot_number,power_bank_id,event_type,payload,occurred_at");
  const [kioskRes, devRes] = await Promise.all([
    stationUuid ? kioskQ.eq("kiosk_id", stationUuid).gte("received_at", winStart ?? "1970-01-01").lte("received_at", winEnd).order("received_at", { ascending: false }).limit(200) : kioskQ.limit(0),
    stationUuid ? devQ.eq("kiosk_id", stationUuid).gte("occurred_at", winStart ?? "1970-01-01").lte("occurred_at", winEnd).order("occurred_at", { ascending: false }).limit(200) : devQ.limit(0),
  ]);
  const { data: commands } = stationUuid
    ? await db.from("device_commands").select("id,kiosk_id,command,status,idempotency_key,payload,created_at,resolved_at").eq("kiosk_id", stationUuid).gte("created_at", winStart ?? "1970-01-01").order("created_at", { ascending: false }).limit(100)
    : { data: [] };
  const { data: stripeEvents } = await db.from("stripe_events").select("id,type,received_at").order("received_at", { ascending: false }).limit(50);
  const { data: tickets } = c.rental_id
    ? await db.from("support_tickets").select("id,ticket_number,rental_id,rental_ref,email,category,description,state,created_at").eq("rental_id", c.rental_id)
    : { data: [] };
  const ticketIds = ((tickets as TicketRow[] | null) ?? []).map((t) => t.id);
  const { data: messages } = ticketIds.length
    ? await db.from("support_messages").select("id,ticket_id,internal,body,created_at").in("ticket_id", ticketIds).order("created_at", { ascending: true }).limit(100)
    : { data: [] };
  return ok({
    rental,
    payments: (payments as PaymentRow[] | null) ?? [],
    ledger: (ledger as LedgerRow[] | null) ?? [],
    entitlementEvents: (entEvents as EntitlementEventRow[] | null) ?? [],
    sponsored: (sponsored as SponsoredRow[] | null) ?? [],
    kioskEvents: (kioskRes.data as KioskEventRow[] | null) ?? [],
    deviceEvents: (devRes.data as DeviceEventRow[] | null) ?? [],
    commands: (commands as CommandRow[] | null) ?? [],
    stripeEvents: (stripeEvents as StripeEventRow[] | null) ?? [],
    tickets: (tickets as TicketRow[] | null) ?? [],
    ticketMessages: (messages as TicketMessageRow[] | null) ?? [],
    windowStart: winStart,
    windowEnd: winEnd,
  } satisfies DossierInput);
}
