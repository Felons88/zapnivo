export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Partners", robots: { index: false, follow: false } };

const STATUS_TONE = { new: "cyan", reviewed: "mist", consultation: "gold", approved: "lime", declined: "mist", installed: "ink" } as const;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default async function Partners() {
  const db = serviceClient();
  const [apps, orgs, venues] = db ? await Promise.all([
    db.from("partner_applications").select("id,business_name,contact_name,email,phone,venue_type,city,state,status,created_at").order("created_at", { ascending: false }).limit(200),
    db.from("organizations").select("id,name").order("created_at", { ascending: false }).limit(100),
    db.from("venues").select("id,name,city,state,published,organization_id").order("created_at", { ascending: false }).limit(200),
  ]) : [null, null, null];

  type App = { id: string; business_name: string; contact_name: string; email: string; phone: string | null; venue_type: string; city: string; state: string; status: keyof typeof STATUS_TONE; created_at: string };
  const appRows = (apps?.data ?? []) as unknown as App[];
  const orgRows = (orgs?.data ?? []) as { id: string; name: string }[];
  const venueRows = (venues?.data ?? []) as { id: string; name: string; city: string; state: string; published: boolean; organization_id: string | null }[];
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));

  return (
    <AdminGate title="Partners" nav="partners">
      {!db ? (
        <EmptyCard title="Partner data not connected">Connect Supabase to see live applications and venues.</EmptyCard>
      ) : (
        <div className="space-y-6">
          <section aria-label="Partner summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Applications" value={appRows.length} sub={`${appRows.filter((a) => a.status === "new").length} new`} />
            <Metric label="Approved / installed" value={appRows.filter((a) => a.status === "approved" || a.status === "installed").length} />
            <Metric label="Organizations" value={orgRows.length} />
            <Metric label="Venues live" value={venueRows.filter((v) => v.published).length} sub={`${venueRows.length} total`} />
          </section>

          <section aria-label="Applications" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Partner applications</h2></div>
            {appRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No applications yet. New venue applications from /business/apply appear here.</p>
            ) : (
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Business", "Contact", "Venue type", "City", "Status", "Applied"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {appRows.map((a) => (
                    <tr key={a.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{a.business_name}</td>
                      <td className="px-4 py-3"><p className="font-semibold">{a.contact_name}</p><p className="text-xs text-graphite">{a.email}{a.phone ? ` · ${a.phone}` : ""}</p></td>
                      <td className="px-4 py-3 text-xs font-semibold">{a.venue_type}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{a.city}, {a.state}</td>
                      <td className="px-4 py-3"><Pill tone={STATUS_TONE[a.status] ?? "mist"}>{a.status}</Pill></td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-label="Venues" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Venues</h2></div>
            {venueRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No venues yet. Venues are created when a partner is approved.</p>
            ) : (
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Venue", "Organization", "City", "Status"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {venueRows.map((v) => (
                    <tr key={v.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{v.name}</td>
                      <td className="px-4 py-3 text-xs font-semibold">{v.organization_id ? orgName.get(v.organization_id) ?? "—" : "—"}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{v.city}, {v.state}</td>
                      <td className="px-4 py-3"><Pill tone={v.published ? "lime" : "mist"}>{v.published ? "live" : "unpublished"}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </AdminGate>
  );
}
