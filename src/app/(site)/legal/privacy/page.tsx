import type { Metadata } from "next";
import { LegalPage, PendingReview } from "@/components/Legal";

export const metadata: Metadata = { title: "Privacy Policy", description: "How Zapnivo collects, uses and protects your information." };

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="November 2026">
      <p>Zapnivo ("we", "us") respects your privacy. This policy describes what information we collect, why, and the choices you have.</p>
      <h2>Information we collect</h2>
      <ul>
        <li><strong>Contact information</strong> you give us in forms (name, email, phone, business details) when you apply for a partnership, contact us, or create a support ticket.</li>
        <li><strong>Rental information</strong>: rental references, station used, and rental times. Payment card details are processed by Stripe — we never see or store full card numbers.</li>
        <li><strong>Support attachments</strong> you choose to upload (e.g. photos of damaged equipment).</li>
        <li><strong>AI assistant conversations</strong>: messages you type into the support assistant (including an email or rental reference you choose to share so it can look up a rental) are sent to OpenRouter, our AI service provider, to generate replies. Do not share card numbers or passwords.
          <PendingReview>Confirm OpenRouter's data-retention and model-training terms and document them here before launch.</PendingReview>
        </li>
        <li><strong>SMS messages</strong>: if you provide a phone number at checkout and opt in, we send transactional rental messages (receipts, reminders and return-deadline notices) via Twilio. Reply STOP at any time to opt out of these messages, or START to resume them. Promotional text messages, if ever offered, require a separate opt-in.</li>
        <li><strong>Technical information</strong> such as IP address, device and browser data used for security, rate limiting and abuse prevention.</li>
      </ul>
      <h2>How we use it</h2>
      <ul>
        <li>To respond to inquiries and process applications.</li>
        <li>To operate rentals, process payments, and resolve disputes.</li>
        <li>To send the transactional rental messages you opted in to at checkout.</li>
        <li>To prevent fraud, spam and abuse of the service.</li>
        <li>To improve the site, using privacy-conscious analytics only with your consent.</li>
      </ul>
      <h2>What we don't do</h2>
      <ul>
        <li>We do not sell your personal information.</li>
        <li>We do not run third-party advertising trackers on this site.</li>
        <li>We do not store payment card numbers.</li>
      </ul>
      <h2>Sharing</h2>
      <p>We share information only with service providers needed to operate the business, under appropriate contracts: Stripe (payments), Supabase (hosting and database), Twilio (SMS), Resend or Brevo (email), and OpenRouter (AI assistant replies). We also disclose information when required by law.</p>
      <h2>Your choices</h2>
      <ul>
        <li>You can decline optional analytics in the consent banner; essential site functionality does not require it.</li>
        <li>If you have an account, you can download a copy of your data or request account deletion from your <a href="/account">account page</a>. Deletion requests are queued for our team; rental, payment and refund records are retained where the law requires it.</li>
        <li>You may also request access to or correction of your information by contacting us.</li>
      </ul>
      <PendingReview>Confirm and publish the state-specific consumer privacy rights that apply to our customers (e.g. Minnesota residents) before launch.</PendingReview>
      <h2>Retention &amp; security</h2>
      <p>We keep information only as long as needed for the purposes above and for legal obligations. Access to submission records is restricted to authorized staff.
        <PendingReview>Document the specific retention periods for each category of data (rental records, support tickets, account data, logs) before launch.</PendingReview>
      </p>
      <h2>Contact</h2>
      <p>Questions about this policy: use the <a href="/contact">contact page</a> and select "General inquiry", or email <a href="mailto:support@zapnivo.com">support@zapnivo.com</a>.
        <PendingReview>Publish a dedicated privacy contact email address here before launch.</PendingReview>
      </p>
    </LegalPage>
  );
}
