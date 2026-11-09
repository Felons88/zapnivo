export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";

export const metadata: Metadata = { title: "Advertising", robots: { index: false, follow: false } };

export default function AdminAds() {
  return (
    <AdminGate title="Advertising management" nav="advertising">
      <EmptyCard title="Campaigns">
        <p>Creative uploads, scheduling, venue targeting and playlists — pending hardware verification. Playback is only reported when a station confirms it; nothing is implied otherwise. Emergency takedown is built into the design.</p>
      </EmptyCard>
      <div className="mt-4"><EmptyCard title="Inquiries"><p>Advertising inquiries submitted via /advertise will be listed here.</p></EmptyCard></div>
    </AdminGate>
  );
}
