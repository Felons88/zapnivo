import type { Metadata } from "next";
import { LegalPage, PendingReview } from "@/components/Legal";

export const metadata: Metadata = { title: "Terms of Service", description: "Terms governing use of the Zapnivo website and services." };

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" updated="November 2026">
      <p>These Terms of Service govern your use of the Zapnivo website and, once launched, the Zapnivo rental service.</p>
      <h2>1. The service</h2>
      <p>Zapnivo operates a self-service network of portable phone-charger rental stations. Station locations, pricing and availability shown on this site are accurate only when marked as live. Pricing shown before launch is pilot pricing and may change before it is finalized.</p>
      <h2>2. Acceptable use</h2>
      <p>You agree not to misuse the website or stations, including attempting to access another user's account or rental, submitting false information, tampering with equipment, or interfering with station operation.</p>
      <h2>3. Rentals</h2>
      <p>Rental terms, including pricing, time limits and return obligations, are shown before each rental and are governed by the <a href="/legal/rental-terms">Rental Terms</a>. Until launch, these terms describe the intended operation only.</p>
      <h2>4. Accounts</h2>
      <p>Administrative and partner portal access is restricted to authorized users. You are responsible for safeguarding your credentials and for activity under your account.</p>
      <h2>5. Intellectual property</h2>
      <p>All content on this site, including the Zapnivo brand, is the property of Zapnivo or its licensors.</p>
      <h2>6. Disclaimers and liability</h2>
      <p>The site is provided "as is". To the extent permitted by law, Zapnivo's liability for any claim arising from use of the site or service is limited, and you agree to indemnify Zapnivo for losses caused by your misuse of the service.</p>
      <PendingReview>Final liability caps, warranty disclaimers, indemnification scope, governing law, venue and dispute-resolution (including any arbitration or class-action waiver) must be completed and approved by counsel before launch.</PendingReview>
      <h2>7. Changes</h2>
      <p>We may update these terms. Material changes will be noted on this page with an updated date.</p>
    </LegalPage>
  );
}
