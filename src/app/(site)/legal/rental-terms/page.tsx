import type { Metadata } from "next";
import { LegalPage } from "@/components/Legal";

export const metadata: Metadata = { title: "Rental Terms", description: "Terms for Zapnivo portable power bank rentals." };

export default function RentalTerms() {
  return (
    <LegalPage title="Rental Terms" updated="November 2026">
      <p>These Rental Terms will govern each power-bank rental once the service launches. Pricing shown before each rental is part of the agreement for that rental. <strong>[REVIEW]</strong></p>
      <h2>Rental period and charges</h2>
      <ul>
        <li>A rental begins when a power bank is released from the station and ends when it is accepted back by an eligible station.</li>
        <li>Charges accrue per started hour up to the stated 24-hour maximum, then at the daily rate shown at checkout for each additional started day. <strong>[REVIEW — finalize additional-day pricing]</strong></li>
        <li>Applicable taxes are added at checkout.</li>
      </ul>
      <h2>Payment authorization</h2>
      <p>A temporary payment authorization may be placed at checkout. Only the final rental charge is captured. <strong>[REVIEW]</strong></p>
      <h2>Returns</h2>
      <ul>
        <li>Power banks must be returned to an eligible participating Zapnivo station listed in your rental.</li>
        <li>If a power bank is not returned within the stated window (proposed: 72 hours), the non-return maximum shown at checkout may be charged and the rental will close.</li>
      </ul>
      <h2>Care and damage</h2>
      <p>You are responsible for the power bank while rented. Report damage via support. Do not disassemble equipment. <strong>[REVIEW]</strong></p>
      <h2>Lost or unreturned equipment</h2>
      <p>Unreturned power banks may be disabled remotely. The non-return charge does not transfer ownership of the power bank. <strong>[REVIEW]</strong></p>
    </LegalPage>
  );
}
