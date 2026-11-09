import type { Metadata } from "next";
import { LegalPage } from "@/components/Legal";

export const metadata: Metadata = { title: "Cookie Policy", description: "What cookies and local storage Zapnivo uses and why." };

export default function Cookies() {
  return (
    <LegalPage title="Cookie Policy" updated="November 2026" review={false}>
      <div className="mb-8"><strong>Note:</strong> This document is a working draft pending legal review.</div>
      <p>Zapnivo aims to use the minimum storage necessary. Here is what the site stores and why.</p>
      <h2>Strictly necessary</h2>
      <ul>
        <li><strong>Session cookie</strong> (<code>zapnivo_access</code>): set only when an authorized staff or partner signs in. HTTP-only, expires when you log out or after one hour.</li>
        <li><strong>Consent preference</strong>: stored in your browser's local storage so we remember your analytics choice. It does not identify you.</li>
      </ul>
      <h2>Optional analytics</h2>
      <p>If you accept in the consent banner, privacy-conscious analytics may record events such as page visits and form completions. Declining changes nothing about how the site works; no advertising trackers are used. <strong>[REVIEW]</strong></p>
      <h2>Managing cookies</h2>
      <p>You can clear site data in your browser at any time. Revisit the consent banner by clearing local storage for this site.</p>
    </LegalPage>
  );
}
