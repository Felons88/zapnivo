import type { Metadata } from "next";
import { LegalPage } from "@/components/Legal";

export const metadata: Metadata = { title: "Privacy Policy", description: "How Zapnivo collects, uses and protects your information." };

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="November 2026">
      <p>Zapnivo ("we", "us") respects your privacy. This policy describes what information we collect, why, and the choices you have. <strong>[REVIEW]</strong></p>
      <h2>Information we collect</h2>
      <ul>
        <li><strong>Contact information</strong> you give us in forms (name, email, phone, business details) when you apply for a partnership, contact us, or create a support ticket.</li>
        <li><strong>Rental information</strong>, once rentals launch: rental references, station used, and rental times. Payment card details are processed by our payment provider — we never see or store full card numbers.</li>
        <li><strong>Support attachments</strong> you choose to upload (e.g. photos of damaged equipment).</li>
        <li><strong>AI assistant conversations</strong>: messages you type into the support assistant (including an email or rental reference you choose to share so it can look up a rental) are processed by an AI service provider to generate replies. Do not share card numbers or passwords. <strong>[REVIEW — name provider and retention]</strong></li>
        <li><strong>Technical information</strong> such as IP address, device and browser data used for security, rate limiting and abuse prevention.</li>
      </ul>
      <h2>How we use it</h2>
      <ul>
        <li>To respond to inquiries and process applications.</li>
        <li>To operate rentals, process payments, and resolve disputes (once live).</li>
        <li>To prevent fraud, spam and abuse of the service.</li>
        <li>To improve the site, using privacy-conscious analytics only with your consent.</li>
      </ul>
      <h2>What we don't do</h2>
      <ul>
        <li>We do not sell your personal information.</li>
        <li>We do not run third-party advertising trackers on this site.</li>
        <li>We do not store payment card numbers. <strong>[REVIEW]</strong></li>
      </ul>
      <h2>Sharing</h2>
      <p>We share information only with service providers needed to operate the business (payment processing, hosting, email) under appropriate contracts, and when required by law. <strong>[REVIEW]</strong></p>
      <h2>Your choices</h2>
      <ul>
        <li>You can decline optional analytics in the consent banner; essential site functionality does not require it.</li>
        <li>You may request access to, correction of, or deletion of your information by contacting us. <strong>[REVIEW — include Minnesota/state-specific rights]</strong></li>
      </ul>
      <h2>Retention &amp; security</h2>
      <p>We keep information only as long as needed for the purposes above and for legal obligations. Access to submission records is restricted to authorized staff. <strong>[REVIEW]</strong></p>
      <h2>Contact</h2>
      <p>Questions about this policy: use the contact page and select "General inquiry". A dedicated privacy email will be published here before launch. <strong>[REVIEW]</strong></p>
    </LegalPage>
  );
}
