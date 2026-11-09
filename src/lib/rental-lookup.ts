import { fmt, PRICING_V1, rentalChargeCents } from "./pricing";

/** DB row shape returned by the lookup query (see /api/support/rental-lookup). */
export type RentalRow = {
  reference: string;
  state: "authorized" | "dispense_pending" | "active" | "returned" | "unreturned" | "cancelled" | "charged_off";
  started_at: string | null;
  dispensed_at: string | null;
  returned_at: string | null;
  non_return_deadline: string | null;
  kiosks: { station_id: string; venues: { name: string; city: string } | null } | null;
  payments: { state: string; amount_captured_cents: number | null; amount_refunded_cents?: number | null; stripe_payment_intent_id?: string | null }[];
};

/** Customer-safe projection: no emails, internal IDs, card data or other customers' info. */
export type RentalResult = {
  reference: string;
  station: string;
  startedAt: string | null;
  returnedAt: string | null;
  status: string;
  tone: "ok" | "info" | "warn";
  chargedCents: number | null;
  refundedCents: number;
  expectedCents: number | null;
  charge: string;
  explanation: string;
  canReportProblem: boolean;
  suggestRefund: boolean;
  ticketCategory: "Refund request" | "Return not recognized" | "Charger did not dispense" | "Billing question";
};

const minutesBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" }) : "");

export function describeRental(r: RentalRow): RentalResult {
  const out = describeRaw(r);
  if (out.chargedCents != null && out.refundedCents >= out.chargedCents && out.chargedCents > 0) {
    return { ...out, suggestRefund: false, tone: "ok", explanation: `This rental has been fully refunded (${fmt(out.refundedCents)}). Refunds go to the original payment method and your bank may take time to show them. ${out.explanation}` };
  }
  return out;
}

function describeRaw(r: RentalRow): RentalResult {
  const P = PRICING_V1;
  const captured = r.payments.reduce((s, p) => s + (p.amount_captured_cents ?? 0), 0);
  const hasCapture = r.payments.some((p) => p.amount_captured_cents != null);
  const chargedCents = hasCapture ? captured : null;
  const refundedCents = r.payments.reduce((s, p) => s + (p.amount_refunded_cents ?? 0), 0);
  const station = r.kiosks?.venues ? `${r.kiosks.venues.name}, ${r.kiosks.venues.city}` : r.kiosks?.station_id ?? "Zapnivo station";

  let expectedCents: number | null = null;
  if (r.state === "returned" && r.dispensed_at && r.returned_at) expectedCents = rentalChargeCents(minutesBetween(r.dispensed_at, r.returned_at), P);

  const base = { reference: r.reference, station, startedAt: r.dispensed_at ?? r.started_at, returnedAt: r.returned_at, chargedCents, refundedCents, expectedCents };
  const chargeText = (chargedCents == null ? "No charge captured" : `${fmt(chargedCents)} captured (before applicable taxes)`) + (refundedCents > 0 ? `, ${fmt(refundedCents)} refunded` : "");

  switch (r.state) {
    case "authorized":
    case "dispense_pending":
      return { ...base, status: "Payment authorized, no power bank released", tone: "warn", charge: chargedCents ? chargeText : "Authorization only — not a charge",
        explanation: "We have a payment authorization but no confirmation that a power bank was released. An authorization is a temporary hold and is released if no rental began. If you were charged, report it and we'll check the station record.",
        canReportProblem: true, suggestRefund: !!chargedCents, ticketCategory: "Charger did not dispense" };
    case "active":
      return { ...base, status: "Rental in progress", tone: "info", charge: `Charges accrue per started hour (${fmt(P.firstHourCents)} first hour, ${fmt(P.additionalHourCents)} each additional) up to ${fmt(P.first24hCapCents)} for the first 24 hours`,
        explanation: `Return the power bank to an eligible participating station to end the rental.${r.non_return_deadline ? ` If it isn't returned by ${when(r.non_return_deadline)}, the non-return maximum of ${fmt(P.nonReturnMaxCents)} may be charged.` : ""} If you already returned it and this still shows as active, report it.`,
        canReportProblem: true, suggestRefund: false, ticketCategory: "Return not recognized" };
    case "returned": {
      const high = expectedCents != null && chargedCents != null && chargedCents > expectedCents;
      return { ...base, status: "Returned", tone: high ? "warn" : "ok", charge: chargeText,
        explanation: high
          ? `Under the published rates, this rental period works out to ${fmt(expectedCents!)} before taxes, which is less than the amount captured. Request a refund review and we'll check it against station and payment records.`
          : expectedCents != null
            ? `Your return was recorded. For this rental period the published rates come to ${fmt(expectedCents)} before taxes.`
            : "Your return was recorded and the rental is closed.",
        canReportProblem: true, suggestRefund: high, ticketCategory: high ? "Refund request" : "Billing question" };
    }
    case "unreturned":
      return { ...base, status: "Not yet returned", tone: "warn", charge: chargeText,
        explanation: `This power bank hasn't been recorded as returned. After ${P.nonReturnAfterHours} hours the non-return maximum of ${fmt(P.nonReturnMaxCents)} may be charged. If you returned it, report it with the station and approximate time so we can verify against station records.`,
        canReportProblem: true, suggestRefund: false, ticketCategory: "Return not recognized" };
    case "charged_off":
      return { ...base, status: "Closed — non-return charge", tone: "warn", charge: chargeText,
        explanation: `The power bank wasn't recorded as returned within ${P.nonReturnAfterHours} hours, so the non-return maximum applied and the rental closed. If you did return it, report it. A verified return can be corrected.`,
        canReportProblem: true, suggestRefund: true, ticketCategory: "Refund request" };
    case "cancelled":
    default:
      return { ...base, status: "Cancelled", tone: "info", charge: chargedCents ? chargeText : "No charge captured",
        explanation: chargedCents ? "This rental was cancelled but a charge was captured. Request a refund review." : "This rental was cancelled and no charge was captured.",
        canReportProblem: !!chargedCents, suggestRefund: !!chargedCents, ticketCategory: "Refund request" };
  }
}
