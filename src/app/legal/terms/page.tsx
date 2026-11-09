import type { Metadata } from "next";
import { LegalPage } from "@/components/Legal";

export const metadata: Metadata = { title: "Terms of Service", description: "Terms governing use of the Zapnivo website and services." };

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" updated="November 2026">
      <p>These Terms of Service govern your use of the Zapnivo website and, once launched, the Zapnivo rental service. <strong>[REVIEW]</strong></p>
      <h2>1. The service</h2>
      <p>Zapnivo operates a self-service network of portable phone-charger rental stations. Station locations, pricing and availability shown on this site are accurate only when marked as live. Pre-launch pricing shown on the site is proposed and subject to change.</p>
      <h2>2. Acceptable use</h2>
      <p>You agree not to misuse the website or stations, including attempting to access another user's account or rental, submitting false information, tampering with equipment, or interfering with station operation.</p>
      <h2>3. Rentals</h2>
      <p>Rental terms, including pricing, time limits and return obligations, are shown before each rental and are governed by the <a href="/legal/rental-terms">Rental Terms</a>. This service is not yet live; until launch these terms describe the intended operation only. <strong>[REVIEW]</strong></p>
      <h2>4. Accounts</h2>
      <p>Administrative and partner portal access is restricted to authorized users. You are responsible for safeguarding your credentials. <strong>[REVIEW]</strong></p>
      <h2>5. Intellectual property</h2>
      <p>All content on this site, including the Zapnivo brand, is the property of Zapnivo or its licensors.</p>
      <h2>6. Disclaimers and liability</h2>
      <p>The site is provided "as is". Liability limitations, warranty disclaimers, indemnification and dispute-resolution terms will be completed in the final version. <strong>[REVIEW — required before launch]</strong></p>
      <h2>7. Changes</h2>
      <p>We may update these terms. Material changes will be noted on this page with an updated date.</p>
    </LegalPage>
  );
}
