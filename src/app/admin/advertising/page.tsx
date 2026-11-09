export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { EmptyCard, PortalGate } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Advertising", robots: { index: false, follow: false } };

const TABS = [
  { href: "/admin", label: "Dashboard" }, { href: "/admin/fleet", label: "Fleet" },
  { href: "/admin/rentals", label: "Rentals" }, { href: "/admin/partners", label: "Partners" },
  { href: "/admin/support", label: "Support" }, { href: "/admin/advertising", label: "Advertising" },
];

export default function AdminAds() {
  return (
    <PortalGate require="staff" eyebrow="Operations" title="Advertising management" tabs={TABS}>
      <EmptyCard title="Campaigns">
        <p>Creative uploads, scheduling, venue targeting and playlists — pending hardware verification. Playback is only reported when a station confirms it; nothing is implied otherwise. Emergency takedown is built into the design.</p>
      </EmptyCard>
      <div className="mt-4"><EmptyCard title="Inquiries"><p>Advertising inquiries submitted via /advertise will be listed here.</p></EmptyCard></div>
    </PortalGate>
  );
}
