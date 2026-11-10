import type { Metadata } from "next";
import { LegalPage } from "@/components/Legal";

export const metadata: Metadata = { title: "Accessibility Statement", description: "Zapnivo's accessibility commitments and how to report barriers." };

export default function Accessibility() {
  return (
    <LegalPage title="Accessibility Statement" updated="November 2026" review={false}>
      <div className="mb-8"><strong>Note:</strong> Working draft; commitments marked [REVIEW] will be validated before launch.</div>
      <p>Zapnivo is committed to a website and rental experience that works for everyone.</p>
      <h2>What we do</h2>
      <ul>
        <li>Semantic HTML, keyboard-navigable navigation, forms and interactive components.</li>
        <li>Visible focus indicators and accessible color-contrast targets.</li>
        <li>Descriptive alt text; decorative imagery is marked accordingly.</li>
        <li>Respect for reduced-motion preferences — animations are decorative only, never required to use the site.</li>
        <li>Form labels, error identification and status announcements.</li>
      </ul>
      <h2>Conformance target</h2>
      <p>We target WCAG 2.2 AA for this website. Physical kiosk accessibility requirements will be evaluated with the manufacturer before installation. <strong>[REVIEW]</strong></p>
      <h2>Report a barrier</h2>
      <p>If anything on this site — or later, at a station — is difficult for you to use, <a href="/support/new">create a support ticket</a> and choose "Accessibility assistance". These reports are prioritized.</p>
    </LegalPage>
  );
}
