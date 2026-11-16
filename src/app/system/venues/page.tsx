export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { VenuesManager } from "./VenuesManager";

export const metadata: Metadata = { title: "Kiosk Infrastructure — Venues" };

type VenueRow = {
  id: string; name: string; venue_type: string; street: string; city: string; state: string;
  zip: string | null; hours: string | null; lat: number | null; lng: number | null;
  published: boolean; organization_id: string | null; equipment_category: string | null;
  created_at: string;
  organizations: { name: string } | { name: string }[] | null;
  kiosks: { id: string; station_id: string | null; state: string; test_mode: boolean | null }[] | null;
};

export default async function SystemVenuesPage() {
  const db = serviceClient();
  const [venuesRes, orgsRes] = db
    ? await Promise.all([
        db.from("venues")
          .select("id,name,venue_type,street,city,state,zip,hours,lat,lng,published,organization_id,equipment_category,created_at,organizations(name),kiosks(id,station_id,state,test_mode)")
          .order("name").limit(500),
        db.from("organizations").select("id,name").order("name").limit(500),
      ])
    : [{ data: [] }, { data: [] }];

  const venues = ((venuesRes as { data?: VenueRow[] }).data ?? []).map((v) => ({
    ...v,
    organization: Array.isArray(v.organizations) ? v.organizations[0]?.name ?? null : v.organizations?.name ?? null,
    kiosks: v.kiosks ?? [],
  }));
  const orgs = (((orgsRes as { data?: { id: string; name: string }[] }).data) ?? []).map((o) => ({ id: o.id, name: o.name }));

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-6">
        <header>
          <p className="eyebrow text-lime">Kiosk Infrastructure</p>
          <h1 className="display-md mt-1 text-slate-100">Venues</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Physical locations that host Zapnivo stations. New venues start <strong>unpublished</strong> — they only appear
            on the public map and accept live rentals once published <em>and</em> a bound kiosk is online with ready banks.
            Test-mode kiosks can rent against an unpublished venue for pre-launch testing.
          </p>
        </header>
        {!db ? (
          <p className="rounded-xl border border-white/10 bg-white/[0.04] p-4 text-sm text-slate-400">Backend not configured — venue management unavailable.</p>
        ) : (
          <VenuesManager venues={venues} orgs={orgs} />
        )}
      </div>
    </SystemGate>
  );
}
