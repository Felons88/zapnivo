export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { EQUIPMENT_LABELS, equipmentLabel, equipmentLabelOr, isEquipmentCategory } from "@/lib/equipment";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Partners", robots: { index: false, follow: false } };

const STATUS_TONE = { new: "cyan", reviewed: "mist", consultation: "gold", approved: "lime", declined: "mist", installed: "ink" } as const;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
/** partner_applications.product_interest is a free-text list of category keys (comma/space separated). */
const interestLabels = (s: string | null) =>
  [...new Set((s ?? "").split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean))]
    .map((t) => (isEquipmentCategory(t) ? EQUIPMENT_LABELS[t] : equipmentLabel(t) ?? t));

export default async function Partners({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string; stm?: string }> }) {
  const feedback = await searchParams;
  const db = serviceClient();
  const [apps, orgs, venues] = db ? await Promise.all([
    db.from("partner_applications").select("id,business_name,contact_name,email,phone,venue_type,city,state,status,created_at,product_interest").order("created_at", { ascending: false }).limit(200),
    db.from("organizations").select("id,name").order("created_at", { ascending: false }).limit(100),
    db.from("venues").select("id,name,city,state,published,organization_id,equipment_category").order("created_at", { ascending: false }).limit(200),
  ]) : [null, null, null];

  type App = { id: string; business_name: string; contact_name: string; email: string; phone: string | null; venue_type: string; city: string; state: string; status: keyof typeof STATUS_TONE; created_at: string; product_interest: string | null };
  const appRows = (apps?.data ?? []) as unknown as App[];
  const orgRows = (orgs?.data ?? []) as { id: string; name: string }[];
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const venueRows = (venues?.data ?? []) as { id: string; name: string; city: string; state: string; published: boolean; organization_id: string | null; equipment_category: string | null }[];

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

          <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
            <Link href="/admin/partners/manage" className="inline-flex min-h-9 items-center rounded-lg bg-ink px-4 text-white hover:bg-forest">Partner operations — orgs, invites, statements, terms →</Link>
            <Link href="/admin/fleet" className="inline-flex min-h-9 items-center rounded-lg border border-mist bg-white px-4 hover:bg-lime/30">Fleet — register kiosks →</Link>
          </div>

          <section aria-label="Applications" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Partner applications</h2></div>
            {appRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No applications yet. New venue applications from /business/apply appear here.</p>
            ) : (
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Business", "Contact", "Venue type", "City", "Status", "Applied", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {appRows.map((a) => (
                    <tr key={a.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold"><Link href={`/admin/partners/applications/${a.id}`} className="text-forest underline hover:text-ink">{a.business_name}</Link></td>
                      <td className="px-4 py-3"><p className="font-semibold">{a.contact_name}</p><p className="text-xs text-graphite">{a.email}{a.phone ? ` · ${a.phone}` : ""}</p></td>
                      <td className="px-4 py-3 text-xs font-semibold">{a.venue_type}{a.product_interest && <p className="mt-1 font-bold text-forest">{interestLabels(a.product_interest).join(" · ")}</p>}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{a.city}, {a.state}</td>
                      <td className="px-4 py-3"><Pill tone={STATUS_TONE[a.status] ?? "mist"}>{a.status}</Pill></td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(a.created_at)}</td>
                      <td className="px-4 py-3"><Link href={`/admin/partners/applications/${a.id}`} className="inline-flex min-h-8 items-center rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-label="Venues" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Venues</h2><Link href="/admin/fleet" className="text-xs font-bold text-forest underline">Add venue or kiosk →</Link></div>
            {venueRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No venues yet. Add one on the Fleet page after reviewing the partner application.</p>
            ) : (
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Venue", "Equipment", "Owner organization", "City", "Status", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {venueRows.map((v) => (
                    <tr key={v.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold"><Link href={`/admin/partners/venues/${v.id}`} className="text-forest underline hover:text-ink">{v.name}</Link></td>
                      <td className="px-4 py-3"><Pill tone={v.equipment_category ? "cyan" : "mist"}>{equipmentLabelOr(v.equipment_category, "unclassified")}</Pill></td>
                      <td className="px-4 py-3 text-xs font-semibold">{v.organization_id ? orgName.get(v.organization_id) ?? "—" : "— unassigned —"}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{v.city}, {v.state}</td>
                      <td className="px-4 py-3"><Pill tone={v.published ? "lime" : "mist"}>{v.published ? "published" : "unpublished"}</Pill></td>
                      <td className="px-4 py-3"><Link href={`/admin/partners/venues/${v.id}`} className="inline-flex min-h-8 items-center rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Manage</Link></td>
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
