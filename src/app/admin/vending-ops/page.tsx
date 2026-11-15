export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { loadVendingOpsDashboard, type VendingOpsDashboard } from "@/lib/vending-ops";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Vending operations", robots: { index: false, follow: false } };

const Unavailable = ({ label }: { label: string }) => (
  <p className="px-6 py-10 text-sm text-graphite">{label} — data unavailable right now.</p>
);

function SectionShell({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
      <div className="border-b border-mist px-6 py-4">
        <h2 className="font-display text-lg font-bold">{title}</h2>
        {sub && <p className="mt-1 text-xs text-graphite">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

const Bar = ({ label, value, max }: { label: string; value: number; max: number }) => (
  <div className="flex items-center gap-3 text-sm">
    <span className="w-40 shrink-0 truncate font-semibold">{label}</span>
    <span className="h-3 flex-1 overflow-hidden rounded-full bg-mist">
      <span className="block h-full rounded-full bg-forest" style={{ width: `${max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0}%` }} />
    </span>
    <span className="w-10 text-right font-bold">{value}</span>
  </div>
);

export default async function VendingOps() {
  const db = serviceClient();
  const d: VendingOpsDashboard | null = db ? await loadVendingOpsDashboard(db) : null;
  const maxStage = d?.placement ? Math.max(1, ...Object.values(d.placement.stageCounts)) : 1;

  return (
    <AdminGate title="Vending operations" nav="vendingOps">
      {!db || !d ? (
        <EmptyCard title="Backend not connected">Connect Supabase to load vending operations data.</EmptyCard>
      ) : (
        <div className="space-y-6">
          <nav aria-label="Vending sections" className="flex flex-wrap gap-2">
            {[
              ["/admin/equipment", "Equipment"], ["/admin/placements", "Placements"], ["/admin/inventory", "Inventory"],
              ["/admin/restock", "Restock"], ["/admin/agreements", "Agreements"], ["/admin/partners", "Partners"],
              ["/admin/profitability", "Profitability"],
            ].map(([href, label]) => (
              <Link key={href} href={href} className="rounded-full border border-silver/60 px-4 py-2 text-xs font-bold text-forest hover:border-ink">{label} →</Link>
            ))}
          </nav>

          <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Placement inquiries (30d)" value={d.placement ? d.placement.inquiries30d : "—"} sub={d.placement ? `${Object.keys(d.placement.stageCounts).length} pipeline stages tracked` : "unavailable"} />
            <Metric label="Equipment units" value={d.units ? d.units.total : "—"} sub={d.units ? `${d.units.byStatus.active ?? 0} active · ${d.units.byStatus.maintenance ?? 0} in maintenance` : "unavailable"} />
            <Metric label="Models" value={d.models ? d.models.total : "—"} sub={d.models ? `${d.models.byStatus.active ?? 0} active models` : "unavailable"} />
            <Metric label="Open service requests" value={d.serviceRequests ? d.serviceRequests.open : "—"} sub={d.serviceRequests ? `${d.serviceRequests.urgentOpen} urgent` : "unavailable"} />
            <Metric label="Agreements" value={d.agreements ? d.agreements.active : "—"} sub={d.agreements ? `${d.agreements.drafts} drafts awaiting approval` : "unavailable"} />
            <Metric label="Restock visits" value={d.restock ? d.restock.planned + d.restock.inProgress : "—"} sub={d.restock ? `${d.restock.planned} planned · ${d.restock.inProgress} in progress` : "unavailable"} />
            <Metric label="Low-stock SKUs" value={d.inventory ? d.inventory.lowStockSkus : "—"} sub={d.inventory ? `${d.inventory.activeSkus} active SKUs` : "unavailable"} />
            <Metric label="Vending revenue" value="—" sub="No vending transaction integration" />
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <SectionShell title="Placement pipeline" sub="partner_applications.placement_stage — all recorded applications">
              {!d.placement ? <Unavailable label="Placement data" /> : Object.keys(d.placement.stageCounts).length === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No placement inquiries yet. New venue applications appear here.</p>
              ) : (
                <div className="space-y-3 px-6 py-5">
                  {Object.entries(d.placement.stageCounts).sort((a, b) => b[1] - a[1]).map(([stage, n]) => <Bar key={stage} label={stage.replace(/_/g, " ")} value={n} max={maxStage} />)}
                  {d.placement.recent.length > 0 && (
                    <ul className="mt-4 space-y-1 border-t border-mist pt-3 text-xs text-graphite">
                      {d.placement.recent.map((r) => <li key={r.id} className="flex justify-between gap-3"><span className="truncate font-semibold text-ink">{r.business_name ?? "Unnamed application"}</span><span>{r.stage?.replace(/_/g, " ") ?? "—"}</span></li>)}
                    </ul>
                  )}
                </div>
              )}
            </SectionShell>

            <SectionShell title="Equipment units" sub="equipment_units lifecycle">
              {!d.units ? <Unavailable label="Unit data" /> : d.units.total === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No vending machines recorded yet.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Status", "Units"].map((h) => <th key={h} className="px-6 py-3 font-extrabold">{h}</th>)}</tr></thead>
                  <tbody>
                    {Object.entries(d.units.byStatus).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
                      <tr key={s} className="border-b border-mist/70 last:border-0"><td className="px-6 py-2.5 font-semibold">{s.replace(/_/g, " ")}</td><td className="px-6 py-2.5 font-bold">{n}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              {d.units && d.units.total > 0 && (
                <p className="border-t border-mist px-6 py-3 text-xs text-graphite">
                  By category: {Object.entries(d.units.byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c.replace(/_/g, " ")} ${n}`).join(" · ")}
                </p>
              )}
            </SectionShell>

            <SectionShell title="Sourcing pipeline" sub="Units not yet deployed">
              {!d.sourcing ? <Unavailable label="Sourcing data" /> : d.sourcing.planned + d.sourcing.sourcing + d.sourcing.ordered + d.sourcing.received === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">Nothing in the sourcing pipeline.</p>
              ) : (
                <div className="space-y-3 px-6 py-5">
                  <Bar label="planned" value={d.sourcing.planned} max={Math.max(1, d.sourcing.planned, d.sourcing.sourcing, d.sourcing.ordered, d.sourcing.received)} />
                  <Bar label="sourcing" value={d.sourcing.sourcing} max={Math.max(1, d.sourcing.planned, d.sourcing.sourcing, d.sourcing.ordered, d.sourcing.received)} />
                  <Bar label="ordered" value={d.sourcing.ordered} max={Math.max(1, d.sourcing.planned, d.sourcing.sourcing, d.sourcing.ordered, d.sourcing.received)} />
                  <Bar label="received" value={d.sourcing.received} max={Math.max(1, d.sourcing.planned, d.sourcing.sourcing, d.sourcing.ordered, d.sourcing.received)} />
                </div>
              )}
            </SectionShell>

            <SectionShell title="Installations" sub="Units assigned or installed at a venue">
              {!d.installations ? <Unavailable label="Installation data" /> : d.installations.assigned + d.installations.installed === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No upcoming installations.</p>
              ) : (
                <div className="px-6 py-5">
                  <p className="text-sm"><b>{d.installations.assigned}</b> assigned · <b>{d.installations.installed}</b> installed awaiting activation</p>
                  {d.installations.upcoming.length > 0 && (
                    <ul className="mt-3 space-y-1.5 text-xs text-graphite">
                      {d.installations.upcoming.map((u) => <li key={u.unitId} className="flex justify-between gap-3"><span className="truncate font-semibold text-ink">{u.label}</span><span>{u.venueName ?? "venue unknown"} · <Pill tone={u.status === "installed" ? "lime" : "cyan"}>{u.status}</Pill></span></li>)}
                    </ul>
                  )}
                </div>
              )}
            </SectionShell>

            <SectionShell title="Service requests" sub="Partner-filed equipment requests">
              {!d.serviceRequests ? <Unavailable label="Service request data" /> : d.serviceRequests.open === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No open service requests.</p>
              ) : (
                <ul className="divide-y divide-mist/70">
                  {d.serviceRequests.recent.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                      <span className="min-w-0"><span className="font-semibold">{r.category}</span> <span className="text-xs text-graphite">· {r.venueName ?? "venue unknown"}</span></span>
                      <span className="flex shrink-0 items-center gap-2"><Pill tone={r.priority === "urgent" ? "red" : r.priority === "high" ? "gold" : "mist"}>{r.priority}</Pill><Pill tone="cyan">{r.status}</Pill></span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionShell>

            <SectionShell title="Revenue" sub="Honest coverage note">
              <div className="px-6 py-6 text-sm text-graphite">
                <p><b className="text-ink">Vending transactions:</b> {d.revenue.reason}. No vending revenue is reported here until a transaction integration exists.</p>
                <p className="mt-3"><b className="text-ink">Charger line (charging kiosks):</b>{" "}
                  {d.partnerEarnings ? (
                    <>gross <b>{fmt(d.partnerEarnings.grossCents)}</b> · partner commission <b>{fmt(d.partnerEarnings.commissionCents)}</b> across {d.partnerEarnings.ledgerPeriods} ledger periods · payouts {d.partnerEarnings.payouts.paid} paid ({fmt(d.partnerEarnings.payouts.paidCents)}), {d.partnerEarnings.payouts.scheduled} scheduled ({fmt(d.partnerEarnings.payouts.scheduledCents)}), {d.partnerEarnings.payouts.failed} failed.</>
                  ) : "unavailable."}
                </p>
                <Link href="/admin/profitability" className="mt-3 inline-block font-bold text-forest underline">Charger unit economics → /admin/profitability</Link>
              </div>
            </SectionShell>
          </div>
        </div>
      )}
    </AdminGate>
  );
}
