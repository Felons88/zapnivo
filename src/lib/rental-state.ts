/** Authoritative rental state machine — legal transitions only, enforced server-side. */

export type RentalState =
  | "pending_payment" | "payment_authorized" | "active" | "return_pending"
  | "returned" | "overdue" | "non_return_fee_pending" | "non_return_fee_paid"
  | "closed" | "disputed"
  // legacy states mapped onto the machine
  | "authorized" | "dispense_pending" | "unreturned" | "cancelled" | "charged_off";

const LEGAL: Record<string, RentalState[]> = {
  pending_payment: ["payment_authorized", "cancelled"],
  payment_authorized: ["active", "dispense_pending", "cancelled"],
  authorized: ["dispense_pending", "active", "cancelled"],
  dispense_pending: ["active", "cancelled"],
  active: ["return_pending", "returned", "overdue"],
  return_pending: ["returned", "active", "overdue"],
  overdue: ["returned", "non_return_fee_pending", "disputed"],
  unreturned: ["returned", "non_return_fee_pending", "disputed"],
  non_return_fee_pending: ["non_return_fee_paid", "disputed", "overdue"],
  non_return_fee_paid: ["closed", "disputed"],
  returned: ["closed", "disputed"],
  charged_off: ["closed", "disputed"],
  disputed: ["closed", "active", "overdue"],
  closed: [],
  cancelled: [],
};

/** Returns true iff `from` may legally move to `to`. Identity transitions are allowed (idempotent). */
export const canTransition = (from: RentalState, to: RentalState) =>
  from === to || (LEGAL[from] ?? []).includes(to);

/** Throws on an illegal transition — use before any state write. */
export function assertTransition(from: string, to: RentalState) {
  if (!canTransition(from as RentalState, to)) throw new Error(`illegal_rental_transition:${from}->${to}`);
}
