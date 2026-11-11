/**
 * Fraud/risk signals (Phase 20 lite) — PURE functions over already-fetched rows.
 *
 * These surface *indicators* for a human investigator. They never accuse, never
 * auto-block, and never feed back into any automated decision. Every signal lists
 * the facts it was derived from so a reviewer can verify it.
 */

export type RiskSeverity = "info" | "warn" | "high";

export type RiskSignal = {
  kind:
    | "repeated_checkout_failures"
    | "excessive_refund_requests"
    | "duplicate_payment_attempts"
    | "gift_claim_failures"
    | "payment_state_anomaly";
  severity: RiskSeverity;
  summary: string;
  facts: string[];
};

export type SignalPayment = {
  id: string; state: string; receipt_email?: string | null;
  amount_captured_cents?: number | null; amount_refunded_cents?: number | null;
  failure_code?: string | null; created_at?: string | null; rental_id?: string | null;
};

export type SignalRefundRequest = {
  id: string; rental_ref?: string | null; status?: string | null;
  amount_cents?: number | null; reason?: string | null; created_at?: string | null;
};

export type SignalGift = {
  id: string; status?: string | null; attempts?: number | null;
  recipient_email?: string | null; last_attempt_at?: string | null;
};

const dayMs = 86_400_000;
const withinDays = (iso: string | null | undefined, days: number, nowMs: number) =>
  iso != null && nowMs - Date.parse(iso) <= days * dayMs && Date.parse(iso) <= nowMs + dayMs;

/** Repeated failed/released checkouts keyed by receipt email in a trailing window. */
export function checkoutFailureSignals(payments: SignalPayment[], nowMs = Date.now()): RiskSignal[] {
  const byEmail = new Map<string, SignalPayment[]>();
  for (const p of payments) {
    if (!["failed", "released"].includes(p.state) || !p.receipt_email) continue;
    if (!withinDays(p.created_at, 30, nowMs)) continue;
    const key = p.receipt_email.toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), p]);
  }
  const out: RiskSignal[] = [];
  for (const [email, rows] of byEmail) {
    if (rows.length < 3) continue;
    out.push({
      kind: "repeated_checkout_failures",
      severity: rows.length >= 6 ? "high" : "warn",
      summary: `${rows.length} failed/released checkout attempts for ${email} in 30 days.`,
      facts: rows.slice(0, 10).map((p) => `payments:${p.id} state=${p.state}${p.failure_code ? ` code=${p.failure_code}` : ""} at ${p.created_at ?? "?"}`),
    });
  }
  return out;
}

/** Many refund requests from the same rental/customer reference. */
export function refundRequestSignals(requests: SignalRefundRequest[], nowMs = Date.now()): RiskSignal[] {
  const byRef = new Map<string, SignalRefundRequest[]>();
  for (const r of requests) {
    if (!r.rental_ref || !withinDays(r.created_at, 90, nowMs)) continue;
    byRef.set(r.rental_ref, [...(byRef.get(r.rental_ref) ?? []), r]);
  }
  const out: RiskSignal[] = [];
  for (const [ref, rows] of byRef) {
    if (rows.length < 2) continue;
    out.push({
      kind: "excessive_refund_requests",
      severity: rows.length >= 4 ? "high" : "warn",
      summary: `${rows.length} refund requests filed against rental ${ref} in 90 days.`,
      facts: rows.map((r) => `refund_requests:${r.id} status=${r.status ?? "?"} amount=${r.amount_cents ?? "?"} reason=${r.reason ?? "?"}`),
    });
  }
  return out;
}

/** Same email with multiple captured payments in a short window (possible double-charge attempts). */
export function duplicatePaymentSignals(payments: SignalPayment[], nowMs = Date.now()): RiskSignal[] {
  const byEmail = new Map<string, SignalPayment[]>();
  for (const p of payments) {
    if (!["captured", "partially_refunded", "refunded"].includes(p.state) || !p.receipt_email) continue;
    if (!withinDays(p.created_at, 7, nowMs)) continue;
    const key = p.receipt_email.toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), p]);
  }
  const out: RiskSignal[] = [];
  for (const [email, rows] of byEmail) {
    const distinctRentals = new Set(rows.map((p) => p.rental_id).filter(Boolean));
    if (distinctRentals.size < 2 || rows.length < 3) continue;
    out.push({
      kind: "duplicate_payment_attempts",
      severity: "warn",
      summary: `${rows.length} captured payments across ${distinctRentals.size} rentals for ${email} in 7 days — verify each was a distinct intended rental.`,
      facts: rows.map((p) => `payments:${p.id} rental=${p.rental_id ?? "?"} captured=${p.amount_captured_cents ?? "?"} at ${p.created_at ?? "?"}`),
    });
  }
  return out;
}

/** Gift claim attempts that keep failing (attempts high, never redeemed). */
export function giftClaimSignals(gifts: SignalGift[]): RiskSignal[] {
  const out: RiskSignal[] = [];
  for (const g of gifts) {
    const attempts = g.attempts ?? 0;
    if (attempts < 5 || g.status === "redeemed") continue;
    out.push({
      kind: "gift_claim_failures",
      severity: attempts >= 10 ? "high" : "warn",
      summary: `Gift ${g.id} has ${attempts} failed claim attempt(s) and is still "${g.status ?? "?"}" — possible token guessing or expired-link confusion.`,
      facts: [
        `gift_credits:${g.id} status=${g.status ?? "?"} attempts=${attempts}`,
        g.recipient_email ? `recipient=${g.recipient_email}` : "no recipient email",
        g.last_attempt_at ? `last_attempt_at=${g.last_attempt_at}` : "no last_attempt_at",
      ],
    });
  }
  return out;
}

/** Payment state anomalies worth a human look (captured with no PI, refunded > captured). */
export function paymentAnomalySignals(payments: SignalPayment[]): RiskSignal[] {
  const out: RiskSignal[] = [];
  for (const p of payments) {
    const captured = p.amount_captured_cents ?? 0;
    const refunded = p.amount_refunded_cents ?? 0;
    if (refunded > captured && captured > 0) {
      out.push({
        kind: "payment_state_anomaly",
        severity: "high",
        summary: `Payment ${p.id} shows ${refunded}¢ refunded against only ${captured}¢ captured.`,
        facts: [`payments:${p.id} state=${p.state} captured=${captured} refunded=${refunded}`],
      });
    }
  }
  return out;
}

/** Convenience: run every signal family over a bundle of rows. */
export function allRiskSignals(input: {
  payments?: SignalPayment[];
  refundRequests?: SignalRefundRequest[];
  gifts?: SignalGift[];
  nowMs?: number;
}): RiskSignal[] {
  const nowMs = input.nowMs ?? Date.now();
  return [
    ...checkoutFailureSignals(input.payments ?? [], nowMs),
    ...refundRequestSignals(input.refundRequests ?? [], nowMs),
    ...duplicatePaymentSignals(input.payments ?? [], nowMs),
    ...giftClaimSignals(input.gifts ?? []),
    ...paymentAnomalySignals(input.payments ?? []),
  ];
}
