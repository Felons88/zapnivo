export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { PartnerGate } from "@/components/PartnerShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { defaultCtx } from "@/lib/helpdesk/service";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Partner Portal", robots: { index: false, follow: false } };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric" }) : "—");
const KIOSK_TONE = { online: "lime", offline: "red", maintenance: "gold", provisioning: "cyan", disabled: "mist" } as const;

export default async function PartnerPortal() {
  return (
    <PartnerGate title="Overview" nav="overview">
      {async ({ user }) => {
        const orgId = user.organizationId;
        const db = serviceClient();
        const ctx = await defaultCtx();
        const [venues, kiosks, rentalCounts, agreements, openTickets] = orgId && db ? await Promise.all([
          db.from("venues").select("id,name,city,state,published,hours").eq("organization_id", orgId).limit(50),
          db.from("kiosks").select("id,station_id,state,last_seen_at,venues!inner(name,organization_id)").eq("venues.organization_id", orgId).limit(50),
          db.from("rentals").select("kiosk_id,state,created_at,kiosks!inner(venues!inner(organization_id))").eq("kiosks.venues.organization_id", orgId).gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString()).limit(5000),
          db.from("partner_agreements").select("id,signed_at,document_path,venues(name)").eq("organization_id", orgId).order("signed_at", { ascending: false }).limit(20),
          ctx ? ctx.repo.listTickets({ orgId, states: ["open", "pending_customer", "pending_internal"], limit: 5 }) : Promise.resolve([]),
        ]) : [{ data: null }, { data: null }, { data: null }, { data: null }, []];

        const venueRows = (venues?.data ?? []) as { id: string; name: string; city: string; state: string; published: boolean; hours: string | null }[];
        const kioskRows = (kiosks?.data ?? []) as unknown as { id: string; station_id: string; state: keyof typeof KIOSK_TONE; last_seen_at: string | null; venues: { name: string }[] | null }[];
        const rentalRows = (rentalCounts?.data ?? []) as { kiosk_id: string; state: string }[];
        const rentalsByKiosk = new Map<string, number>();
        for (const r of rentalRows) rentalsByKiosk.set(r.kiosk_id, (rentalsByKiosk.get(r.kiosk_id) ?? 0) + 1);
        const active = rentalRows.filter((r) => r.state === "active" || r.state === "dispense_pending").length;
        const agrRows = (agreements?.data ?? []) as unknown as { id: string; signed_at: string | null; document_path: string | null; venues: { name: string }[] | null }[];
        const docs = db ? (await Promise.all(agrRows.map(async (a) => ({
          ...a,
          url: a.document_path ? (await db.storage.from("agreements").createSignedUrl(a.document_path, 300)).data?.signedUrl ?? null : null,
        })))) : agrRows.map((a) => ({ ...a, url: null }));

        return (
          <div className="space-y-6">
            {!orgId && <EmptyCard title="No venue linked yet">Your account isn't attached to a venue organization. Once your agreement is active, your stations and statements appear here.</EmptyCard>}
            <section aria-label="Your business" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Stations" value={kioskRows.length} sub={`${kioskRows.filter((k) => k.state === "online").length} online`} />
              <Metric label="Rentals (30 days)" value={rentalRows.length} sub={`${active} active now`} />
              <Metric label="Venues" value={venueRows.length} sub={`${venueRows.filter((v) => v.published).length} live`} />
              <Metric label="Open requests" value={openTickets.length} sub="With Zapnivo support" />
            </section>

            <section aria-label="Your stations" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Your stations</h2></div>
              {kioskRows.length === 0 ? (
                <div className="px-6 py-10"><p className="text-sm text-graphite">No stations installed yet. Your kiosk appears here after installation.</p><Link href="/partners/demo" className="mt-3 inline-block text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Preview a populated portal →</Link></div>
              ) : (
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Station", "Venue", "Status", "Rentals (30d)", "Last seen"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                  <tbody>
                    {kioskRows.map((k) => (
                      <tr key={k.id} className="border-b border-mist/70 last:border-0">
                        <td className="px-4 py-3 font-bold">{k.station_id}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{k.venues?.[0]?.name ?? "—"}</td>
                        <td className="px-4 py-3"><Pill tone={KIOSK_TONE[k.state] ?? "mist"}>{k.state}</Pill></td>
                        <td className="px-4 py-3 font-display font-bold">{rentalsByKiosk.get(k.id) ?? 0}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(k.last_seen_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <section aria-label="Venues" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Your venues</h2>
                {venueRows.length === 0 ? <p className="mt-4 text-sm text-graphite">None registered yet.</p> : (
                  <ul className="mt-4 space-y-3">
                    {venueRows.map((v) => (
                      <li key={v.id} className="flex items-center justify-between gap-3 text-sm">
                        <span><b>{v.name}</b> <span className="text-graphite">· {v.city}, {v.state}</span></span>
                        <Pill tone={v.published ? "lime" : "mist"}>{v.published ? "live" : "pending"}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section aria-label="Agreements" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Agreements</h2>
                {docs.length === 0 ? <p className="mt-4 text-sm text-graphite">Your signed agreement and addenda will be available for download here.</p> : (
                  <ul className="mt-4 space-y-3 text-sm">
                    {docs.map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-3">
                        <span><b>{a.venues?.[0]?.name ?? "Partnership agreement"}</b><span className="text-graphite">{a.signed_at ? ` · signed ${new Date(a.signed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : " · unsigned"}</span></span>
                        {a.url ? <a href={a.url} className="shrink-0 rounded-full border border-silver/60 px-3 py-1.5 text-xs font-bold hover:border-ink">Download ↓</a> : <span className="text-xs text-graphite">Pending</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section aria-label="Open requests" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between"><h2 className="font-display text-lg font-bold">Open requests</h2><Link href="/partners/support" className="text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">All →</Link></div>
                {openTickets.length === 0 ? <p className="mt-4 text-sm text-graphite">Nothing open. Station problems? Raise a request and we handle it.</p> : (
                  <ul className="mt-4 space-y-2 text-sm">
                    {openTickets.map((t) => <li key={t.id}><Link href={`/partners/support/${t.number}`} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-mist/50"><span className="truncate"><b>{t.number}</b> · {t.subject}</span><span className="shrink-0 text-xs text-graphite">{t.state.replace("_", " ")}</span></Link></li>)}
                  </ul>
                )}
              </section>
            </div>
          </div>
        );
      }}
    </PartnerGate>
  );
}
