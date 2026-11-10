import type { Metadata } from "next";
import { LegalPage, PendingReview } from "@/components/Legal";

export const metadata: Metadata = { title: "Rental Terms", description: "Terms for Zapnivo portable power bank rentals." };

export default function RentalTerms() {
  return (
    <LegalPage title="Rental Terms" updated="November 2026">
      <p>These Rental Terms govern each power-bank rental. The pricing shown before each rental is part of the agreement for that rental.</p>
      <h2>Rental period and charges</h2>
      <ul>
        <li>A rental begins when a power bank is released from the station (verified activation) and ends when it is accepted back by an eligible station.</li>
        <li>Rental charges are <strong>$6.99 per started hour</strong> — any part of an hour counts as a full hour — calculated using the pricing shown before checkout.</li>
        <li>Applicable taxes are added at checkout.</li>
      </ul>
      <PendingReview>Charges for rental periods beyond 24 hours have not been finalized. This page will be updated with the confirmed post-24-hour pricing before launch; do not rely on any figure until then.</PendingReview>
      <h2>Payment authorization</h2>
      <p>At checkout, Stripe places a temporary authorization (hold) on your card. The final rental charge is captured only when your power bank's return is verified by the station. If a rental ends without a verified return, the authorization may be captured for the applicable charges.</p>
      <h2>Returns</h2>
      <ul>
        <li>Power banks must be returned to an eligible participating Zapnivo station listed in your rental.</li>
        <li>You have <strong>24 hours from verified activation</strong> to return the power bank.</li>
        <li>If the power bank is not returned by that 24-hour deadline, a <strong>$45.00 non-return fee</strong> is assessed. This fee is separate from your rental charges and is not a cap on them. Returning before the deadline avoids the fee, and the fee is never charged twice for the same rental.</li>
      </ul>
      <h2>Care and damage</h2>
      <p>You are responsible for the power bank while it is rented. Do not disassemble equipment. Report any damage or malfunction through <a href="/support/new">support</a>; see the <a href="/legal/refund-policy">Refund Policy</a> for how defective-equipment charges are handled.</p>
      <PendingReview>Confirm the damage-reporting process, any damage-fee schedule, and who bears loss for lost or stolen power banks before launch.</PendingReview>
      <h2>Lost or unreturned equipment</h2>
      <p>A power bank that is not returned by the 24-hour deadline may be disabled remotely, and the $45.00 non-return fee described above applies. The non-return fee does not transfer ownership of the power bank to you.</p>
      <PendingReview>Confirm replacement-cost or recovery language for lost or stolen power banks before launch.</PendingReview>
    </LegalPage>
  );
}
