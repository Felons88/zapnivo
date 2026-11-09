import { fmt, PRICING_V1 } from "../pricing";
import { describeRental, type RentalRow } from "../rental-lookup";
import type { RefundReason } from "./types";

/**
 * Refund policy engine. Mirrors /legal/refund-policy and the help-center articles. It SUGGESTS
 * and VALIDATES; a human always decides. Amounts are integer cents.
 */

/** Agents may approve up to the first-24-hour cap. Above this (or large goodwill) needs an admin AND a second person. */
export const AGENT_APPROVAL_LIMIT_CENTS = PRICING_V1.first24hCapCents;
export const GOODWILL_AGENT_LIMIT_CENTS = PRICING_V1.firstHourCents;

export const REASON_LABEL: Record<RefundReason, string> = {
  failed_dispense: "Paid but no power bank released",
  return_not_recognized: "Return not recognized, kept billing",
  defective_equipment: "Defective power bank",
  overcharge: "Charged above the published rate",
  goodwill: "Goodwill (discretionary)",
};

export type RentalSnapshot = { reference: string; capturedCents: number; refundedCents: number; remainingCents: number; paymentIntentId: string | null; row: RentalRow };

export function snapshot(row: RentalRow): RentalSnapshot {
  const captured = row.payments.reduce((s, p) => s + (p.amount_captured_cents ?? 0), 0);
  const refunded = row.payments.reduce((s, p) => s + (p.amount_refunded_cents ?? 0), 0);
  const pay = row.payments.find((p) => p.stripe_payment_intent_id) ?? null;
  return { reference: row.reference, capturedCents: captured, refundedCents: refunded, remainingCents: Math.max(0, captured - refunded), paymentIntentId: pay?.stripe_payment_intent_id ?? null, row };
}

export type Suggestion = { suggestedCents: number; eligible: boolean; rationale: string };

export function suggestRefund(snap: RentalSnapshot, reason: RefundReason): Suggestion {
  const { remainingCents: left } = snap;
  if (left <= 0) return { suggestedCents: 0, eligible: false, rationale: "Nothing left to refund. The captured amount is already fully refunded, or no charge was captured." };
  const expected = describeRental(snap.row).expectedCents;
  switch (reason) {
    case "failed_dispense": {
      const dispensed = !!snap.row.dispensed_at && ["active", "returned", "unreturned", "charged_off"].includes(snap.row.state);
      return dispensed
        ? { suggestedCents: 0, eligible: false, rationale: "Station records show a power bank WAS released. Check device events before refunding as a failed dispense." }
        : { suggestedCents: left, eligible: true, rationale: `No release is recorded. Policy: refund the captured charge (${fmt(left)}).` };
    }
    case "return_not_recognized":
      if (snap.row.state !== "returned" || expected == null) return { suggestedCents: 0, eligible: false, rationale: "No verified return on record. Verify the return against station/device events first, then use Overcharge for the difference." };
      return left > expected
        ? { suggestedCents: Math.min(left, snap.capturedCents - expected - snap.refundedCents), eligible: true, rationale: `Return verified. Published rate for the actual period is ${fmt(expected)}; refund the excess.` }
        : { suggestedCents: 0, eligible: false, rationale: `Charge (${fmt(snap.capturedCents)}) does not exceed the published rate for the period (${fmt(expected)}).` };
    case "overcharge":
      if (expected == null) return { suggestedCents: 0, eligible: false, rationale: "Expected charge can't be computed (period beyond 24h pricing, or no verified return)." };
      return snap.capturedCents - snap.refundedCents > expected
        ? { suggestedCents: snap.capturedCents - snap.refundedCents - expected, eligible: true, rationale: `Captured ${fmt(snap.capturedCents)} vs published ${fmt(expected)} for this period.` }
        : { suggestedCents: 0, eligible: false, rationale: "Charge does not exceed the published rate for this period." };
    case "defective_equipment":
      return { suggestedCents: left, eligible: true, rationale: "Policy: defective equipment that couldn't hold a charge may be refunded after review. Confirm the report and device history." };
    case "goodwill":
      return { suggestedCents: Math.min(left, GOODWILL_AGENT_LIMIT_CENTS), eligible: true, rationale: `Discretionary. Above ${fmt(GOODWILL_AGENT_LIMIT_CENTS)} requires an admin.` };
  }
}

export function requiresAdmin(amountCents: number, reason: RefundReason): boolean {
  return amountCents > AGENT_APPROVAL_LIMIT_CENTS || (reason === "goodwill" && amountCents > GOODWILL_AGENT_LIMIT_CENTS);
}
