export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Partners", robots: { index: false, follow: false } };

const STATUS_TONE = { new: "cyan", reviewed: "mist", consultation: "gold", approved: "lime", declined: "mist", installed: "ink" } as const;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default async function Partners({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string; stm?: string }> }) {
  const feedback = await searchParams;
  const db = serviceClient();
  const [apps, orgs, venues] = db ? await Promise.all([
    db.from("partner_applications").select("id,business_name,contact_name,email,phone,venue_type,city,state,status,created_at").order("created_at", { ascending: false }).limit(200),
    db.from("organizations").select("id,name").order("created_at", { ascending: false }).limit(100),
    db.from("venues").select("id,name,city,state,published,organization_id,lat,lng").order("created_at", { ascending: false }).limit(200),
  ]) : [null, null, null];

  type App = { id: string; business_name: string; contact_name: string; email: string; phone: string | null; venue_type: string; city: string; state: string; status: keyof typeof STATUS_TONE; created_at: string };
  const appRows = (apps?.data ?? []) as unknown as App[];
  const orgRows = (orgs?.data ?? []) as { id: string; name: string }[];
  const venueRows = (venues?.data ?? []) as { id: string; name: string; city: string; state: string; published: boolean; organization_id: string | null; lat: number | null; lng: number | null }[];

  return (
    <AdminGate title="Partners" nav="partners">
      {!db ? (
        <EmptyCard title="Partner data not connected">Connect Supabase to see live applications and venues.</EmptyCard>
      ) : (
        <div className="space-y-6">
          {(feedback.result || feedback.stm) && <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>
            {feedback.result === "error" ? feedback.detail : feedback.result === "org" ? "Organization created." : feedback.result === "invited" ? "Partner invitation sent and account linked to the organization." : feedback.result === "linked" ? "Existing account linked to the organization." : feedback.result === "application" ? "Application status saved." : feedback.result === "venue" ? "Venue owner saved." : feedback.result === "converted" ? "Approved application added as an unpublished venue. Register its kiosk on Fleet." : feedback.result === "map" ? "Venue map settings saved." : feedback.stm === "none" ? "No statements exist for that month." : feedback.stm ? `${feedback.stm} statement email(s) queued.` : "Saved."}
          </div>}
          <section aria-label="Partner summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Applications" value={appRows.length} sub={`${appRows.filter((a) => a.status === "new").length} new`} />
            <Metric label="Approved / installed" value={appRows.filter((a) => a.status === "approved" || a.status === "installed").length} />
            <Metric label="Organizations" value={orgRows.length} />
            <Metric label="Venues published" value={venueRows.filter((v) => v.published).length} sub={`${venueRows.length} total · map also requires a verified online kiosk`} />
          </section>

          <section aria-label="Applications" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Partner applications</h2></div>
            {appRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No applications yet. New venue applications from /business/apply appear here.</p>
            ) : (
              <table className="w-full min-w-[1050px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Business", "Contact", "Venue type", "City", "Status", "Set up venue", "Applied"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {appRows.map((a) => (
                    <tr key={a.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{a.business_name}</td>
                      <td className="px-4 py-3"><p className="font-semibold">{a.contact_name}</p><p className="text-xs text-graphite">{a.email}{a.phone ? ` · ${a.phone}` : ""}</p></td>
                      <td className="px-4 py-3 text-xs font-semibold">{a.venue_type}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{a.city}, {a.state}</td>
                      <td className="px-4 py-3"><form method="post" action="/api/admin/partners" className="flex items-center gap-2"><input type="hidden" name="action" value="update_application" /><input type="hidden" name="application_id" value={a.id} /><select name="status" defaultValue={a.status} aria-label={`Status for ${a.business_name}`} className="min-h-9 rounded-lg border border-silver/60 px-2 text-xs font-semibold">{Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{s}</option>)}</select><button className="min-h-9 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Save</button></form></td>
                      <td className="px-4 py-3">{a.status === "approved" ? <form method="post" action="/api/admin/partners" className="flex items-center gap-2"><input type="hidden" name="action" value="create_venue_from_application" /><input type="hidden" name="application_id" value={a.id} /><select name="organization_id" required defaultValue="" aria-label={`Owner organization for ${a.business_name}`} className="min-h-9 rounded-lg border border-silver/60 px-2 text-xs font-semibold"><option value="" disabled>Organization…</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select><button className="min-h-9 rounded-full bg-ink px-3 text-xs font-bold text-white">Create venue</button></form> : <span className="text-xs text-graphite">Approve first</span>}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
            <section id="invite-partner" aria-label="Invite owner" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Invite a site owner</h2>
              <form method="post" action="/api/admin/partners" className="mt-4 space-y-3">
                <input type="hidden" name="action" value="invite_partner" />
                <div><label htmlFor="i-email" className="mb-1 block text-xs font-bold">Email</label><input id="i-email" name="email" type="email" required className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" placeholder="owner@bar.com" /></div>
                <div><label htmlFor="i-name" className="mb-1 block text-xs font-bold">Name</label><input id="i-name" name="name" className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" placeholder="Alex Rivera" /></div>
                <div><label htmlFor="i-org" className="mb-1 block text-xs font-bold">Organization</label>
                  <select id="i-org" name="organization_id" required className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm"><option value="">Select…</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
                <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Send invite</button>
              </form>
              <p className="mt-3 text-xs text-graphite">Sends a Supabase sign-up email. The owner's portal shows earnings for every venue on that org — one owner, many locations.</p>
            </section>
            <section aria-label="New organization" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">New organization</h2>
              <form method="post" action="/api/admin/partners" className="mt-4 space-y-3">
                <input type="hidden" name="action" value="create_org" />
                <div><label htmlFor="o-name" className="mb-1 block text-xs font-bold">Business name</label><input id="o-name" name="name" required className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" placeholder="Northside Hospitality LLC" /></div>
                <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Create</button>
              </form>
              <p className="mt-3 text-xs text-graphite">One organization can own several venues. Assign each venue in the table below.</p>
            </section>
            <section aria-label="Link existing owner" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Link existing account</h2>
              <form method="post" action="/api/admin/partners" className="mt-4 space-y-3">
                <input type="hidden" name="action" value="link_profile" />
                <div><label htmlFor="l-email" className="mb-1 block text-xs font-bold">Account email</label><input id="l-email" name="email" type="email" required className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" /></div>
                <div><label htmlFor="l-org" className="mb-1 block text-xs font-bold">Organization</label><select id="l-org" name="organization_id" required className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm"><option value="">Select…</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
                <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Link account</button>
              </form>
              <p className="mt-3 text-xs text-graphite">For an account that already exists. Staff accounts cannot be converted.</p>
            </section>
            <section id="statements" aria-label="Monthly statements" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Monthly statements</h2>
              <form method="post" action="/api/admin/statements" className="mt-4 space-y-3">
                <div><label htmlFor="s-period" className="mb-1 block text-xs font-bold">Period</label><input id="s-period" name="period" required pattern="\d{4}-(0[1-9]|1[0-2])" className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" placeholder="2026-05" /></div>
                <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Queue statement emails</button>
              </form>
              <a href="/admin/payouts" className="mt-3 inline-block text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Ledgers &amp; payouts →</a>
              <p className="mt-3 text-xs text-graphite">Emails one statement per venue to each owner on the org, through the outbox — nothing claims sent if mail isn't configured.</p>
            </section>
          </div>

          <section aria-label="Agreement terms" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Record agreement terms <span className="ml-2 align-middle text-[10px] font-extrabold uppercase tracking-widest text-silver">admin · private</span></h2>
            <form method="post" action="/api/admin/partners" className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="action" value="set_agreement" />
              <div><label htmlFor="a-org" className="mb-1 block text-xs font-bold">Organization</label><select id="a-org" name="organization_id" required className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm"><option value="">Select…</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
              <div><label htmlFor="a-venue" className="mb-1 block text-xs font-bold">Venue (blank = all)</label><select id="a-venue" name="venue_id" className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm"><option value="">All venues</option>{venueRows.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
              <div><label htmlFor="a-pct" className="mb-1 block text-xs font-bold">Commission %</label><input id="a-pct" name="commission_pct" type="number" step="0.01" min="0" max="100" required className="min-h-10 w-28 rounded-lg border border-silver/70 px-3 text-sm" /></div>
              <div><label htmlFor="a-date" className="mb-1 block text-xs font-bold">Signed</label><input id="a-date" name="signed_at" type="date" className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm" /></div>
              <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Save terms</button>
            </form>
            <p className="mt-3 text-xs text-graphite">Stored in the private agreement record and used only by the ledger job. Never shown publicly; the newest agreement per venue wins.</p>
          </section>

          <section aria-label="Venues" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Venues</h2><Link href="/admin/fleet" className="text-xs font-bold text-forest underline">Add venue or kiosk →</Link></div>
            {venueRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No venues yet. Add one on the Fleet page after reviewing the partner application.</p>
            ) : (
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Venue", "Owner organization", "City", "Status"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {venueRows.map((v) => (
                    <tr key={v.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{v.name}</td>
                      <td className="px-4 py-3 text-xs font-semibold"><form method="post" action="/api/admin/partners" className="flex items-center gap-2"><input type="hidden" name="action" value="assign_venue_org" /><input type="hidden" name="venue_id" value={v.id} /><select name="organization_id" defaultValue={v.organization_id ?? ""} aria-label={`Owner of ${v.name}`} className="min-h-9 rounded-lg border border-silver/60 px-2 text-xs font-semibold"><option value="">— unassigned —</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select><button className="min-h-9 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Save</button></form></td>
                      <td className="px-4 py-3 text-xs text-graphite">{v.city}, {v.state}</td>
                      <td className="px-4 py-3"><Pill tone={v.published ? "lime" : "mist"}>{v.published ? "published" : "unpublished"}</Pill><details className="mt-2"><summary className="cursor-pointer text-xs font-bold text-forest underline">Map settings</summary><form method="post" action="/api/admin/partners" className="mt-2 flex w-56 flex-col gap-2"><input type="hidden" name="action" value="save_venue_map" /><input type="hidden" name="venue_id" value={v.id} /><label className="text-xs">Latitude<input name="lat" type="number" step="any" min="-90" max="90" defaultValue={v.lat ?? ""} placeholder="45.5602" className="mt-1 min-h-9 w-full rounded-lg border border-silver/60 px-2" /></label><label className="text-xs">Longitude<input name="lng" type="number" step="any" min="-180" max="180" defaultValue={v.lng ?? ""} placeholder="-94.1625" className="mt-1 min-h-9 w-full rounded-lg border border-silver/60 px-2" /></label><label className="flex items-center gap-2 text-xs"><input name="published" type="checkbox" value="yes" defaultChecked={v.published} />Publish on map</label><p className="text-[11px] leading-4 text-graphite">Requires verified coordinates and an installed kiosk reporting online.</p><button className="min-h-9 rounded-full bg-ink px-3 text-xs font-bold text-white">Save map settings</button></form></details></td>
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
