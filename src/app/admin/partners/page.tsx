export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { EmptyCard, PortalGate } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Partners", robots: { index: false, follow: false } };

const TABS = [
  { href: "/admin", label: "Dashboard" }, { href: "/admin/fleet", label: "Fleet" },
  { href: "/admin/rentals", label: "Rentals" }, { href: "/admin/partners", label: "Partners" },
  { href: "/admin/support", label: "Support" }, { href: "/admin/advertising", label: "Advertising" },
];

export default function Partners() {
  return (
    <PortalGate require="staff" eyebrow="Operations" title="Partner management" tabs={TABS}>
      <div className="grid gap-4 lg:grid-cols-2">
        <EmptyCard title="Partner applications"><p>New venue applications appear here once Supabase is connected. Pipeline: inquiry → consultation → site approval → installation → ongoing support.</p></EmptyCard>
        <EmptyCard title="Venue records"><p>Authorized contacts, installation details and support history per venue.</p></EmptyCard>
        <EmptyCard title="Agreements & commissions"><p>Agreement records and commission configuration — private financial terms, never shown on public pages. Visible to authorized staff and the owning venue only.</p></EmptyCard>
        <EmptyCard title="Payouts"><p>Monthly statements and payment status will populate once commission ledgers are active.</p></EmptyCard>
      </div>
    </PortalGate>
  );
}
