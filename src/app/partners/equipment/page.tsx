export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { PartnerGate } from "@/components/PartnerShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { equipmentLabelOr } from "@/lib/equipment";
import { listAgreements } from "@/lib/vending-agreements";
import { SERVICE_REQUEST_CATEGORIES, SERVICE_REQUEST_PRIORITIES, listOrgServiceRequests } from "@/lib/vending-ops";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Equipment", robots: { index: false, follow: false } };

const REQ_TONE: Record<string, "lime" | "cyan" | "gold" | "mist" | "red"> = {
  new: "cyan", acknowledged: "gold", scheduled: "lime", completed: "mist", cancelled: "red",
};
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export default async function PartnerEquipment({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string }> }) {
  const feedback = await searchParams;
  return (
    <PartnerGate title="Equipment" nav="equipment">
      {async ({ user }) => {
        const orgId = user.organizationId;
        const db = serviceClient();
        if (!orgId || !db) {
          return <EmptyCard title="No organization linked">Your account isn't attached to a venue organization yet, so there's no equipment to show.</EmptyCard>;
        }

        const [venueRes, agreements, requests] = await Promise.all([
          db.from("venues").select("id,name,equipment_category,city,state").eq("organization_id", orgId).order("name").limit(200),
          listAgreements(db, { org_id: orgId }),
          listOrgServiceRequests(db, orgId),
        ]);
        const venues = (venueRes.data ?? []) as { id: string; name: string; equipment_category: string | null; city: string; state: string }[];
        const venueIds = venues.map((v) => v.id);

        // Units sit at org venues (service-role read; RLS also scopes partners).
        const unitsRes = venueIds.length
          ? await db.from("equipment_units").select("id,venue_id,category,status,model_label,serial_number").in("venue_id", venueIds).order("created_at", { ascending: false }).limit(500)
          : { data: [] as never[] };
        const units = (unitsRes.data ?? []) as { id: string; venue_id: string | null; category: string; status: string; model_label: string | null; serial_number: string | null }[];
        const venueName = (id: string | null) => venues.find((v) => v.id === id)?.name ?? null;

        // Agreements recorded against this org OR its venues (listAgreements org filter covers organization_id; add venue-scoped rows).
        const venueAgreements = venueIds.length
          ? await listAgreements(db, {}).then((all) => all.filter((a) => venueIds.includes(a.venue_id)))
          : [];
        const seen = new Set(agreements.map((a) => a.id));
        const allAgreements = [...agreements, ...venueAgreements.filter((a) => !seen.has(a.id))]
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

        const openRequests = requests.filter((r) => !["completed", "cancelled"].includes(r.status));

        return (
          <div className="space-y-6">
            {(feedback.result || feedback.detail) && (
              <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>
                {feedback.result === "error" ? (feedback.detail ?? "Something went wrong.") : "Service request submitted — Zapnivo will review it."}
              </div>
            )}

            <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Venues" value={venues.length} sub="On your organization" />
              <Metric label="Equipment units" value={units.length} sub="Across your venues" />
              <Metric label="Active agreements" value={allAgreements.filter((a) => a.status === "active").length} sub={`${allAgreements.length} total versions`} />
              <Metric label="Open requests" value={openRequests.length} sub="With Zapnivo" />
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <section aria-label="Equipment" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Your equipment</h2>
                {units.length === 0 ? (
                  <p className="mt-4 text-sm text-graphite">No vending machines recorded at your venues yet. Units appear here once equipment is assigned or installed.</p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {units.map((u) => (
                      <li key={u.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0">
                          <span className="block truncate font-bold">{u.model_label ?? u.serial_number ?? `${u.category.replace(/_/g, " ")} unit`}</span>
                          <span className="text-xs text-graphite">{equipmentLabelOr(u.category, "unclassified")} · {venueName(u.venue_id) ?? "unassigned"}</span>
                        </span>
                        <Pill tone={u.status === "active" ? "lime" : u.status === "maintenance" ? "gold" : "mist"}>{u.status.replace(/_/g, " ")}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-label="Agreements" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Your agreements</h2>
                <p className="mt-1 text-xs text-graphite">Revenue-share terms per venue and equipment category. The active version is the one currently in force.</p>
                {allAgreements.length === 0 ? (
                  <p className="mt-4 text-sm text-graphite">No equipment agreements on file yet. Your Zapnivo contact will share terms once placements are agreed.</p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {allAgreements.slice(0, 12).map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0">
                          <span className="block truncate font-bold">{a.venueName ?? "Venue"} · {a.equipment_category.replace(/_/g, " ")}</span>
                          <span className="text-xs text-graphite">v{a.version} · {a.revenue_share_pct != null ? `${a.revenue_share_pct}% revenue share` : "terms on file"}</span>
                        </span>
                        <Pill tone={a.status === "active" ? "lime" : a.status === "terminated" ? "red" : "mist"}>{a.status}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section aria-label="New service request" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Request service</h2>
              <p className="mt-1 text-xs text-graphite">Restock issues, repairs, equipment problems — routed to the Zapnivo operations team.</p>
              {venues.length === 0 ? (
                <p className="mt-4 text-sm text-graphite">No venues on your organization yet, so requests can't be filed.</p>
              ) : (
                <form method="post" action="/api/partners/service-requests" className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="sr-venue" className="mb-1 block text-xs font-bold">Venue</label>
                    <select id="sr-venue" name="venue_id" required className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm">
                      {venues.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.city}, {v.state}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="sr-unit" className="mb-1 block text-xs font-bold">Unit (optional)</label>
                    <select id="sr-unit" name="unit_id" className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm">
                      <option value="">Whole venue / general</option>
                      {units.map((u) => <option key={u.id} value={u.id}>{u.model_label ?? u.serial_number ?? u.id.slice(0, 8)} · {venueName(u.venue_id) ?? ""}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="sr-cat" className="mb-1 block text-xs font-bold">Category</label>
                    <select id="sr-cat" name="category" className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm">
                      {SERVICE_REQUEST_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="sr-prio" className="mb-1 block text-xs font-bold">Priority</label>
                    <select id="sr-prio" name="priority" className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm">
                      {SERVICE_REQUEST_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="sr-desc" className="mb-1 block text-xs font-bold">What's happening?</label>
                    <textarea id="sr-desc" name="description" required minLength={10} maxLength={3000} rows={4} className="w-full rounded-lg border border-silver/70 px-3 py-2 text-sm" placeholder="e.g. Snack machine at the bar is out of the top shelf and the card reader timed out twice." />
                  </div>
                  <div className="sm:col-span-2">
                    <button className="min-h-10 rounded-full bg-ink px-6 text-sm font-bold text-white">Submit request</button>
                  </div>
                </form>
              )}
            </section>

            <section aria-label="Service requests" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Your requests</h2></div>
              {requests.length === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No service requests yet.</p>
              ) : (
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                    <tr>{["Submitted", "Venue", "Category", "Priority", "Status"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id} className="border-b border-mist/70 last:border-0">
                        <td className="px-4 py-3 text-xs text-graphite">{day(r.created_at)}</td>
                        <td className="px-4 py-3 font-semibold">{venueName(r.venue_id) ?? "—"}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{r.category}</td>
                        <td className="px-4 py-3"><Pill tone={r.priority === "urgent" ? "red" : r.priority === "high" ? "gold" : "mist"}>{r.priority}</Pill></td>
                        <td className="px-4 py-3"><Pill tone={REQ_TONE[r.status] ?? "mist"}>{r.status}</Pill></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        );
      }}
    </PartnerGate>
  );
}
