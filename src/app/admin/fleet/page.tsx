export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { EmptyCard, PortalGate } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Fleet", robots: { index: false, follow: false } };

const TABS = [
  { href: "/admin", label: "Dashboard" }, { href: "/admin/fleet", label: "Fleet" },
  { href: "/admin/rentals", label: "Rentals" }, { href: "/admin/partners", label: "Partners" },
  { href: "/admin/support", label: "Support" }, { href: "/admin/advertising", label: "Advertising" },
];

export default function Fleet() {
  return (
    <PortalGate require="staff" eyebrow="Operations" title="Fleet management" tabs={TABS}>
      <EmptyCard title="Station registry">
        <p>Stations are registered here once hardware provisioning begins. Each station gets a unique server-side ID used by QR codes and rental sessions.</p>
      </EmptyCard>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <EmptyCard title="Slot inventory"><p>Per-slot status (empty / charging / ready / fault) will stream in once the kiosk adapter is connected to real hardware.</p></EmptyCard>
        <EmptyCard title="Maintenance & hardware errors"><p>Hardware error reports and maintenance history appear here. Remote disable/dispense actions require elevated roles and are audit-logged.</p></EmptyCard>
      </div>
    </PortalGate>
  );
}
