export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { EmptyCard, PortalGate } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

const TABS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/fleet", label: "Fleet" },
  { href: "/admin/rentals", label: "Rentals" },
  { href: "/admin/partners", label: "Partners" },
  { href: "/admin/support", label: "Support" },
  { href: "/admin/advertising", label: "Advertising" },
];

export default function AdminDashboard() {
  return (
    <PortalGate require="staff" eyebrow="Operations" title="Dashboard" tabs={TABS}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <EmptyCard title="Active stations"><p>No stations are registered yet. The first kiosk will appear here once provisioned.</p></EmptyCard>
        <EmptyCard title="Active rentals"><p>Rentals go live with the first station.</p></EmptyCard>
        <EmptyCard title="Revenue"><p>Revenue reporting activates with payment integration.</p></EmptyCard>
        <EmptyCard title="Open tickets"><p>New support tickets will appear here once Supabase is connected.</p></EmptyCard>
      </div>
    </PortalGate>
  );
}
