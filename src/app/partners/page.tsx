export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { EmptyCard, PortalGate } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Partner Portal", robots: { index: false, follow: false } };

const TABS = [
  { href: "/partners", label: "Overview" },
  { href: "/partners/payouts", label: "Payouts" },
  { href: "/partners/support", label: "Support" },
];

export default function PartnerPortal() {
  return (
    <PortalGate require="partner" eyebrow="Venue partner" title="Your venue" tabs={TABS}>
      <div className="grid gap-4 lg:grid-cols-2">
        <EmptyCard title="Kiosk status">
          <p>Your station's status, slot inventory and connectivity will appear here once your installation is live. You only see venues you're authorized for.</p>
        </EmptyCard>
        <EmptyCard title="Rental activity">
          <p>Aggregated rental counts for your venue — never customer payment details or other venues' data.</p>
        </EmptyCard>
        <EmptyCard title="Monthly payout statements">
          <p>Statements reflecting your private partnership terms appear here once active. Financial terms are never visible publicly.</p>
        </EmptyCard>
        <EmptyCard title="Agreement documents">
          <p>Your signed agreement and any addenda will be available for download here.</p>
        </EmptyCard>
      </div>
    </PortalGate>
  );
}
