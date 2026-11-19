export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { Notice } from "@/components/ui";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";
import { venueOpportunityAnalysis } from "@/lib/unit-economics";

export const metadata: Metadata = { title: "Venue opportunities", robots: { index: false, follow: false } };

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

export default async function OpportunitiesPage() {
  const db = serviceClient();
  const data = db ? await venueOpportunityAnalysis(db, { days: 30 }).catch(() => null) : null;
  const unavailable = data?.unavailable ?? [];

  const venuesWithKiosks = data?.venues.filter((v) => v.kioskCount > 0).length ?? 0;
  const estimateCount = data?.venues.filter((v) => v.scenarioStatus === "estimate").length ?? 0;

  return (
    <AdminGate title="Venue opportunities" nav="opportunities">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-graphite">
            Observed window: last {data?.window.days ?? 30} days ({data ? `${data.window.start} → ${data.window.end}` : "—"}).
            Scenario figures are <b>estimates</b> — network-average assumptions, never guaranteed revenue.
          </p>
          <Link href="/admin/partners" className="rounded-full border border-silver/60 px-4 py-1.5 text-xs font-bold hover:border-ink">
            Partner pipeline →
          </Link>
        </div>

        {!db ? (
          <EmptyCard title="Opportunity data not connected">Connect Supabase to analyze venue placement.</EmptyCard>
        ) : data === null ? (
          <Notice title="Analysis unavailable.">The opportunity query failed — try again shortly.</Notice>
        ) : (
          <>
            {unavailable.length > 0 && (
              <Notice title="Partial data.">
                Could not load: {unavailable.join(", ")} — affected figures are zeroed, not estimated.
              </Notice>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Venues on file" value={data.venues.length} sub={`${venuesWithKiosks} with kiosks`} />
              <Metric label="Prospective applications" value={data.applications.length} sub="partner pipeline" />
              <Metric
                label="Network avg rentals/day"
                value={data.networkAvgRentalsPerDay ?? "—"}
                sub={data.networkAvgRentalsPerDay === null ? "insufficient history" : "observed, feeds scenarios"}
              />
              <Metric
                label="Avg ticket (observed)"
                value={data.networkAvgTicketCents !== null ? fmt(data.networkAvgTicketCents) : "—"}
                sub={data.networkAvgCommissionPct !== null ? `network avg commission ${data.networkAvgCommissionPct}% (assumption)` : "no commission data"}
              />
            </div>

            <p className="text-xs text-graphite">
              Foot-traffic data source (assumption): <b>{data.footTrafficIndex ?? "unknown"}</b>.
              Scenario = network-average rentals/day × {data.applications[0]?.scenarioDays ?? 30} days × avg ticket × (1 − commission%).
            </p>

            {/* ── Existing venues ── */}
            <section className="rounded-2xl border border-mist bg-white p-4">
              <h2 className="text-lg font-bold">Existing venues</h2>
              <p className="mt-1 text-xs text-graphite">
                Observed rentals/gross are real. Scenario columns are estimates based on network averages — labelled, not promised.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[1080px] text-sm">
                  <thead>
                    <tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite">
                      <th className="py-2 pr-4">Venue</th>
                      <th className="py-2 pr-4">Type</th>
                      <th className="py-2 pr-4 text-right">Kiosks</th>
                      <th className="py-2 pr-4 text-right">Rentals/day</th>
                      <th className="py-2 pr-4 text-right">Gross (window)</th>
                      <th className="py-2 pr-4 text-right">Commission</th>
                      <th className="py-2 pr-4 text-right">Scenario est. (30d)</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.venues.map((v) => (
                      <tr key={v.id} className="border-b border-mist/60 align-top">
                        <td className="py-2.5 pr-4">
                          <p className="font-semibold">{v.name}</p>
                          <p className="text-xs text-graphite">{[v.city, v.published ? "published" : "unpublished"].filter(Boolean).join(" · ")}</p>
                        </td>
                        <td className="py-2.5 pr-4 text-graphite">{v.venueType ?? "—"}</td>
                        <td className="py-2.5 pr-4 text-right">{v.kioskCount}</td>
                        <td className="py-2.5 pr-4 text-right">{v.observedRentalsPerDay.toFixed(2)}</td>
                        <td className="py-2.5 pr-4 text-right">{fmt(v.grossRevenueCents)}</td>
                        <td className="py-2.5 pr-4 text-right">
                          {pct(v.commissionPct)}
                          <p className="text-[10px] font-normal text-graphite">
                            {v.commissionSource === "agreement" ? "agreement" : v.commissionSource === "network_average" ? "network avg · assumption" : "none"}
                          </p>
                        </td>
                        <td className="py-2.5 pr-4 text-right">
                          {v.scenarioNetCents !== null ? (
                            <>
                              <p className="font-bold">{fmt(v.scenarioNetCents)}</p>
                              <p className="text-[10px] font-normal text-graphite">gross {v.scenarioGrossCents !== null ? fmt(v.scenarioGrossCents) : "—"} · est.</p>
                            </>
                          ) : v.scenarioGrossCents !== null ? (
                            <>
                              <p className="font-bold">{fmt(v.scenarioGrossCents)}</p>
                              <p className="text-[10px] font-normal text-graphite">gross only · est.</p>
                            </>
                          ) : "—"}
                        </td>
                        <td className="py-2.5 text-xs text-graphite">
                          {v.scenarioStatus === "estimate" ? <Pill tone="lime">estimate</Pill> : <Pill tone="mist">insufficient data</Pill>}
                        </td>
                      </tr>
                    ))}
                    {data.venues.length === 0 && (
                      <tr><td colSpan={8} className="py-8 text-center text-graphite">No venues on file yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {data.truncated && <p className="mt-2 text-xs font-bold text-ink">Warning: hit the row safety cap — counts may be truncated.</p>}
              {estimateCount > 0 && (
                <p className="mt-3 text-xs text-graphite">
                  {estimateCount} venue{estimateCount === 1 ? "" : "s"} show scenario estimates — each is the network-average projection, not a forecast of that venue's demand.
                </p>
              )}
            </section>

            {/* ── Prospective applications ── */}
            <section className="rounded-2xl border border-mist bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-bold">Prospective venues</h2>
                <Link href="/admin/partners" className="text-xs font-bold text-forest underline">Open partner pipeline →</Link>
              </div>
              <p className="mt-1 text-xs text-graphite">
                Applications have no operating history — scenario estimates are withheld rather than invented.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite">
                      <th className="py-2 pr-4">Business</th>
                      <th className="py-2 pr-4">Type</th>
                      <th className="py-2 pr-4">Location</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Applied</th>
                      <th className="py-2">Scenario</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.applications.map((a) => (
                      <tr key={a.id} className="border-b border-mist/60 align-top">
                        <td className="py-2.5 pr-4 font-semibold">{a.name}</td>
                        <td className="py-2.5 pr-4 text-graphite">{a.venueType ?? "—"}</td>
                        <td className="py-2.5 pr-4 text-graphite">{a.city ?? "—"}</td>
                        <td className="py-2.5 pr-4"><Pill tone="mist">{a.status}</Pill></td>
                        <td className="py-2.5 pr-4 text-xs text-graphite">{day(a.createdAt)}</td>
                        <td className="py-2.5 text-xs text-graphite">
                          <Pill tone="mist">insufficient data</Pill>
                          <p className="mt-1 max-w-[280px] text-[11px]">{a.scenarioNote}</p>
                        </td>
                      </tr>
                    ))}
                    {data.applications.length === 0 && (
                      <tr><td colSpan={6} className="py-8 text-center text-graphite">No prospective applications.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </AdminGate>
  );
}
