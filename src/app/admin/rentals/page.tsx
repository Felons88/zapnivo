export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { EmptyCard, PortalGate } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Rentals", robots: { index: false, follow: false } };

const TABS = [
  { href: "/admin", label: "Dashboard" }, { href: "/admin/fleet", label: "Fleet" },
  { href: "/admin/rentals", label: "Rentals" }, { href: "/admin/partners", label: "Partners" },
  { href: "/admin/support", label: "Support" }, { href: "/admin/advertising", label: "Advertising" },
];

export default function Rentals() {
  return (
    <PortalGate require="staff" eyebrow="Operations" title="Rental management" tabs={TABS}>
      <div className="grid gap-4 lg:grid-cols-2">
        <EmptyCard title="Rental records"><p>Searchable rental history with state tracking (authorized → dispensed → returned / unreturned) appears once rentals launch.</p></EmptyCard>
        <EmptyCard title="Payments"><p>Authorization and capture status, refunds, disputes and audit history will be populated by Stripe webhooks — never by client-side events.</p></EmptyCard>
        <EmptyCard title="Unreturned devices"><p>Workflow for the 72-hour window, reminder notifications and non-return maximum captures.</p></EmptyCard>
        <EmptyCard title="Refunds & disputes"><p>Refund escalation and dispute management tied to rental and payment records.</p></EmptyCard>
      </div>
    </PortalGate>
  );
}
