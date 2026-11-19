export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { agreementCategoryOptions, listAgreements, type AgreementStatus } from "@/lib/vending-agreements";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Equipment agreements", robots: { index: false, follow: false } };

const TONE: Record<AgreementStatus, "lime" | "cyan" | "mist" | "red"> = { active: "lime", draft: "cyan", superseded: "mist", terminated: "red" };
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const pct = (n: number | null) => (n == null ? "—" : `${n}%`);

export default async function Agreements({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string }> }) {
  const feedback = await searchParams;
  const db = serviceClient();
  const [agreements, venuesRes, orgsRes] = db ? await Promise.all([
    listAgreements(db),
    db.from("venues").select("id,name,organization_id").order("name").limit(500),
    db.from("organizations").select("id,name").order("name").limit(500),
  ]) : [[], null, null];
  const venueRows = (venuesRes?.data ?? []) as { id: string; name: string; organization_id: string | null }[];
  const orgRows = (orgsRes?.data ?? []) as { id: string; name: string }[];
  const orgName = (id: string | null) => orgRows.find((o) => o.id === id)?.name ?? null;

  return (
    <AdminGate title="Equipment agreements" nav="agreements">
      {!db ? (
        <EmptyCard title="Backend not connected">Connect Supabase to manage equipment agreements.</EmptyCard>
      ) : (
        <div className="space-y-4">
          {(feedback.result || feedback.detail) && (
            <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>
              {feedback.result === "error" ? (feedback.detail ?? "Something went wrong.") : feedback.result === "draft" ? "Agreement draft created." : feedback.result === "approved" ? "Agreement approved — previous active version superseded." : feedback.result === "terminated" ? "Agreement terminated." : "Saved."}
            </div>
          )}

          <section aria-label="New agreement draft" className="rounded-2xl border border-mist bg-white p-4 shadow-sm">
            <h2 className="font-display text-lg font-bold">New agreement draft</h2>
            <p className="mt-1 text-xs text-graphite">Drafts are never active until an admin approves them. Approving supersedes the previous active version for the same venue + category.</p>
            <form method="post" action="/api/admin/agreements" className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="action" value="create_draft" />
              <div>
                <label htmlFor="ag-venue" className="mb-1 block text-xs font-bold">Venue</label>
                <select id="ag-venue" name="venue_id" required className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm">
                  <option value="">Select…</option>
                  {venueRows.map((v) => <option key={v.id} value={v.id}>{v.name}{v.organization_id ? ` · ${orgName(v.organization_id) ?? "org"}` : ""}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ag-cat" className="mb-1 block text-xs font-bold">Equipment category</label>
                <select id="ag-cat" name="equipment_category" required className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm">
                  {agreementCategoryOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ag-pct" className="mb-1 block text-xs font-bold">Revenue share %</label>
                <input id="ag-pct" name="revenue_share_pct" type="number" step="0.01" min="0" max="100" className="min-h-10 w-32 rounded-lg border border-silver/70 px-3 text-sm" placeholder="e.g. 12.5" />
              </div>
              <div>
                <label htmlFor="ag-from" className="mb-1 block text-xs font-bold">Effective from</label>
                <input id="ag-from" name="effective_from" type="date" className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm" />
              </div>
              <div className="min-w-52 flex-1">
                <label htmlFor="ag-notes" className="mb-1 block text-xs font-bold">Notes (stored in terms)</label>
                <input id="ag-notes" name="notes" maxLength={500} className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" placeholder="Optional context for reviewers" />
              </div>
              <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Create draft</button>
            </form>
          </section>

          <section aria-label="Agreements" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-4 py-4"><h2 className="font-display text-lg font-bold">Agreement versions</h2></div>
            {agreements.length === 0 ? (
              <p className="px-4 py-8 text-sm text-graphite">No equipment agreements yet. Create a draft above, then approve it to make it the active version.</p>
            ) : (
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Venue", "Org", "Category", "Ver", "Status", "Effective", "Share", "Approved", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {agreements.map((a) => (
                    <tr key={a.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{a.venueName ?? "Unknown venue"}<p className="text-xs font-semibold text-graphite">{[a.venueCity, a.venueState].filter(Boolean).join(", ")}</p></td>
                      <td className="px-4 py-3 text-xs font-semibold">{a.orgName ?? orgName(a.organization_id) ?? "—"}</td>
                      <td className="px-4 py-3 text-xs font-semibold">{a.equipment_category.replace(/_/g, " ")}</td>
                      <td className="px-4 py-3 font-bold">v{a.version}</td>
                      <td className="px-4 py-3"><Pill tone={TONE[a.status] ?? "mist"}>{a.status}</Pill></td>
                      <td className="px-4 py-3 text-xs text-graphite">{day(a.effective_from)} → {day(a.effective_to)}</td>
                      <td className="px-4 py-3 text-xs font-semibold">{pct(a.revenue_share_pct)}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{a.approved_at ? day(a.approved_at) : "—"}</td>
                      <td className="px-4 py-3">
                        {a.status === "draft" && (
                          <form method="post" action="/api/admin/agreements"><input type="hidden" name="action" value="approve" /><input type="hidden" name="agreement_id" value={a.id} /><button className="min-h-9 rounded-full bg-lime px-3 text-xs font-bold text-ink hover:bg-[#e6ffa8]">Approve</button></form>
                        )}
                        {a.status === "active" && (
                          <form method="post" action="/api/admin/agreements" className="flex items-center gap-2"><input type="hidden" name="action" value="terminate" /><input type="hidden" name="agreement_id" value={a.id} /><input name="reason" maxLength={300} placeholder="Reason" className="min-h-9 w-32 rounded-lg border border-silver/60 px-2 text-xs" /><button className="min-h-9 rounded-full bg-red-100 px-3 text-xs font-bold text-red-900 hover:bg-red-200">Terminate</button></form>
                        )}
                      </td>
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
