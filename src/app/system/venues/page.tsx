export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { serviceClient } from "@/lib/supabase";
import { VENUE_ADMIN_SELECT } from "@/lib/venues";
import { VenuesManager, type OrgItem, type VenueItem } from "./VenuesManager";

export const metadata: Metadata = { title: "Venues" };

export default async function SystemVenuesPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");

  let venues: VenueItem[] = [];
  let organizations: OrgItem[] = [];
  if (db) {
    const [{ data }, { data: orgs }] = await Promise.all([
      db.from("venues").select(VENUE_ADMIN_SELECT).order("name").limit(500),
      db.from("organizations").select("id,name").order("name").limit(200),
    ]);
    const rows = (data ?? []) as Omit<VenueItem, "kiosk_count" | "device_count">[];
    organizations = (orgs ?? []) as OrgItem[];
    const ids = rows.map((v) => v.id);
    const [kiosks, devices] = ids.length ? await Promise.all([
      db.from("kiosks").select("venue_id").in("venue_id", ids),
      db.from("system_devices").select("venue_id").in("venue_id", ids),
    ]) : [{ data: [] as { venue_id: string | null }[] }, { data: [] as { venue_id: string | null }[] }];
    const count = (list: { venue_id: string | null }[] | null) => {
      const m = new Map<string, number>();
      for (const r of list ?? []) if (r.venue_id) m.set(r.venue_id, (m.get(r.venue_id) ?? 0) + 1);
      return m;
    };
    const kc = count(kiosks.data as { venue_id: string | null }[] | null);
    const dc = count(devices.data as { venue_id: string | null }[] | null);
    venues = rows.map((v) => ({ ...v, kiosk_count: kc.get(v.id) ?? 0, device_count: dc.get(v.id) ?? 0 }));
  }

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-6">
        <header>
          <p className="eyebrow text-lime">Kiosk Infrastructure</p>
          <h1 className="display-md mt-1 text-slate-100">Venues &amp; locations</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Search Mapbox to prefill a venue, verify the details, and publish when it&apos;s verified live.
            Published venues with an installed, online station appear on the website and in the app.
            Internal contact info and notes never leave this console.
          </p>
        </header>
        <VenuesManager venues={venues} organizations={organizations} canManage={canManage} />
      </div>
    </SystemGate>
  );
}
