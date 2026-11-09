export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { EmptyCard, PortalGate } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Payouts", robots: { index: false, follow: false } };

const TABS = [
  { href: "/partners", label: "Overview" },
  { href: "/partners/payouts", label: "Payouts" },
  { href: "/partners/support", label: "Support" },
];

export default function Payouts() {
  return (
    <PortalGate require="partner" eyebrow="Venue partner" title="Payouts" tabs={TABS}>
      <EmptyCard title="Payout history">
        <p>Monthly statements and payment status will appear here once your station is live and commission ledgers are active. Terms shown here reflect your private agreement only.</p>
      </EmptyCard>
    </PortalGate>
  );
}
