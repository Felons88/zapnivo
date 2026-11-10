import type { Metadata } from "next";
import { LegalPage } from "@/components/Legal";

export const metadata: Metadata = { title: "Refund Policy", description: "How Zapnivo handles refund requests for rentals." };

export default function Refund() {
  return (
    <LegalPage title="Refund Policy" updated="November 2026">
      <p>This policy describes how refund requests are handled for Zapnivo rentals. Every request is reviewed by our support team against station and payment records before any refund is issued.</p>
      <h2>When refunds are issued</h2>
      <ul>
        <li><strong>Failed dispense:</strong> if payment was captured but no power bank was released, the rental charge is refunded or the authorization released.</li>
        <li><strong>Return not recognized:</strong> if a power bank was returned but the rental continued to bill, the overcharge beyond the correct amount is refunded.</li>
        <li><strong>Charged above the published rate:</strong> if you were charged more than the published pricing for your rental period, the difference is refunded.</li>
        <li><strong>Defective equipment:</strong> if a dispensed power bank could not hold a charge, the rental charge may be refunded after review.</li>
      </ul>
      <h2>When refunds are not issued</h2>
      <ul>
        <li>Charges for time a power bank was actually kept, billed correctly at the published rate.</li>
        <li>The $45.00 non-return fee where the power bank was not returned by the 24-hour deadline, unless the return is later verified by station records.</li>
      </ul>
      <h2>How to request</h2>
      <p><a href="/support/new">Create a support ticket</a> and select "Refund request". Include your rental reference and the email used at checkout. Requests are reviewed against station and payment records. You retain the right to dispute a charge with your card issuer.</p>
      <h2>Timing</h2>
      <p>Approved refunds are issued to the original payment method. Bank posting times vary and are outside our control.</p>
      <p>For the rental charges and deadlines these refunds relate to, see the <a href="/legal/rental-terms">Rental Terms</a>.</p>
    </LegalPage>
  );
}
