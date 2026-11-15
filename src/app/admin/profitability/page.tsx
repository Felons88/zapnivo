export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { Notice } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";
import { kioskUnitEconomics, listAssumptionItems, type KioskEconomics } from "@/lib/unit-economics";

export const metadata: Metadata = { title: "Fleet profitability", robots: { index: false, follow: false } };

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—");
const num = (v: number | null, digits = 1) => (v === null ? "—" : v.toFixed(digits));
const trendTone = (d: string) => (d === "up" ? "lime" : d === "down" ? "red" : "mist") as "lime" | "red" | "mist";
const trendLabel = (d: string) => (d === "up" ? "rising" : d === "down" ? "falling" : "flat");

function KioskRow({ k }: { k: KioskEconomics }) {
  return (
    <tr className="border-b border-mist/60 align-top">
      <td className="py-2.5 pr-4">
        <p className="font-semibold">{k.stationId ?? k.kioskId.slice(0, 8)}</p>
        <p className="text-xs text-graphite">
          {[k.venueName, k.venueCity].filter(Boolean).join(" · ") || "No venue linked"}
          {k.kioskState ? ` · ${k.kioskState}` : ""}
        </p>
      </td>
      <td className="py-2.5 pr-4 text-right">{k.rentalCount}</td>
      <td className="py-2.5 pr-4 text-right">{fmt(k.grossRevenueCents)}</td>
      <td className="py-2.5 pr-4 text-right">{num(k.rentalsPerDay, 2)}</td>
      <td className="py-2.5 pr-4 text-right">{k.avgRentalValueCents !== null ? fmt(k.avgRentalValueCents) : "—"}</td>
      <td className="py-2.5 pr-4 text-right" title="Proxy: distinct days with ≥1 rental ÷ window days — not a real utilization meter.">
        {num(k.utilizationProxy * 100, 0)}%
      </td>
      <td className="py-2.5 pr-4"><Pill tone={trendTone(k.revenueTrend.direction)}>{trendLabel(k.revenueTrend.direction)}</Pill></td>
      <td className="py-2.5 pr-4 text-right text-xs">
        <p>opex {fmt(k.monthlyOpexCents)}/mo <span className="text-graphite">(assumption)</span></p>
        <p>setup {fmt(k.oneTimeCostCents)} <span className="text-graphite">(assumption)</span></p>
      </td>
      <td className="py-2.5 text-right font-bold">
        {k.estimatedPaybackMonths !== null ? `${num(k.estimatedPaybackMonths)} mo` : "—"}
        <p className="text-[10px] font-normal text-graphite">est. · assumption-based</p>
      </td>
    </tr>
  );
}

export default async function ProfitabilityPage({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string }> }) {
  const feedback = await searchParams;
  const db = serviceClient();
  const user = await getSessionUser();
  const isAdmin = user?.role === "admin";

  const [econ, assumptions] = db
    ? await Promise.all([kioskUnitEconomics(db, { days: 30 }).catch(() => null), listAssumptionItems(db).catch(() => null)])
    : [null, null];

  const n = econ?.network ?? null;
  const unavailable = econ?.unavailable ?? [];

  return (
    <AdminGate title="Fleet profitability" nav="profitability">
      <div className="space-y-8">
        <p className="text-sm text-graphite">
          Unit economics over the last {econ?.window.days ?? 30} days ({econ ? `${econ.window.start} → ${econ.window.end}` : "—"}).
          Revenue figures are observed payments; every cost, payback and monthly figure is an{" "}
          <b>assumption-based estimate</b> — not accounting truth.
        </p>

        {feedback.result && (
          <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>
            {feedback.result === "error" ? feedback.detail ?? "The action failed." : `Assumption ${feedback.detail ?? ""} ${feedback.result}.`}
          </div>
        )}

        {!db ? (
          <EmptyCard title="Profitability data not connected">Connect Supabase to compute kiosk unit economics.</EmptyCard>
        ) : econ === null ? (
          <Notice title="Economics unavailable.">The economics query failed — try again shortly.</Notice>
        ) : (
          <>
            {unavailable.length > 0 && (
              <Notice title="Partial data.">
                Could not load: {unavailable.join(", ")} — affected columns show zeros/— rather than estimates.
              </Notice>
            )}
            {econ.assumptionsDegraded && (
              <Notice title="Assumptions unavailable.">Could not read admin_finance_assumptions — defaults (all zero) are in use. Set values below once the table is reachable.</Notice>
            )}

            {/* ── Network rollup ── */}
            <section>
              <h2 className="text-lg font-bold">Network rollup — last {econ.window.days} days</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Metric label="Rentals (observed)" value={n?.rentalCount ?? 0} sub={`${n?.rentalsPerDay ?? 0}/day avg`} />
                <Metric label="Gross captured (observed)" value={n ? fmt(n.grossRevenueCents) : "—"} sub="captured − refunded" />
                <Metric label="Active kiosks" value={n ? `${n.activeKiosks}/${n.kioskCount}` : "—"} sub="with ≥1 rental in window" />
                <Metric
                  label="Est. payback (network)"
                  value={n?.estimatedPaybackMonths != null ? `${num(n.estimatedPaybackMonths)} mo` : "—"}
                  sub="assumption-based · one-time ÷ net monthly"
                />
              </div>
              {n && (
                <p className="mt-3 text-xs text-graphite">
                  Assumption-based monthly view: est. gross {fmt(n.estimatedMonthlyGrossCents)}/mo − assumed opex {fmt(n.monthlyOpexCents)}/mo
                  {" "}= net {fmt(Math.max(0, n.netMonthlyContributionCents))}/mo · one-time setup {fmt(n.oneTimeCostCents)} (all assumptions, editable below).
                </p>
              )}
            </section>

            {/* ── Per-kiosk table ── */}
            <section className="rounded-2xl border border-mist bg-white p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-bold">Per-kiosk economics</h2>
                <p className="text-xs font-bold uppercase tracking-wider text-graphite">observed + assumption-based estimate</p>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead>
                    <tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite">
                      <th className="py-2 pr-4">Kiosk / venue</th>
                      <th className="py-2 pr-4 text-right">Rentals</th>
                      <th className="py-2 pr-4 text-right">Gross</th>
                      <th className="py-2 pr-4 text-right">/day</th>
                      <th className="py-2 pr-4 text-right">Avg value</th>
                      <th className="py-2 pr-4 text-right">Util. proxy</th>
                      <th className="py-2 pr-4">Trend</th>
                      <th className="py-2 pr-4 text-right">Monthly opex · setup</th>
                      <th className="py-2 text-right">Payback est.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {econ.kiosks.map((k) => <KioskRow key={k.kioskId} k={k} />)}
                    {econ.kiosks.length === 0 && (
                      <tr><td colSpan={9} className="py-8 text-center text-graphite">No kiosks on file yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {econ.truncated && <p className="mt-2 text-xs font-bold text-ink">Warning: hit the row safety cap — counts may be truncated.</p>}
              <p className="mt-3 text-xs text-graphite">
                Utilization proxy = days with ≥1 rental ÷ window days (not metered). Trend compares gross captured in the second vs first half of the window.
                Payback = (hardware + install assumptions) ÷ (monthlyized gross − monthly opex assumptions); shown only when net contribution is positive.
              </p>
            </section>

            {/* ── Assumption editor ── */}
            <section className="rounded-2xl border border-mist bg-white p-6">
              <h2 className="text-lg font-bold">Economics assumptions</h2>
              <p className="mt-1 text-xs text-graphite">
                Stored in <code>admin_finance_assumptions</code> — editable inputs, not transactions. Every figure above that uses them is labelled assumption-based.
                {!isAdmin && " Only admins can change these values."}
              </p>
              {assumptions === null ? (
                <p className="mt-4 text-sm text-graphite">Assumption list unavailable.</p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[860px] text-sm">
                    <thead>
                      <tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite">
                        <th className="py-2 pr-4">Key</th>
                        <th className="py-2 pr-4">Label</th>
                        <th className="py-2 pr-4">Unit</th>
                        <th className="py-2 pr-4">Value</th>
                        <th className="py-2 pr-4">Updated</th>
                        {isAdmin && <th className="py-2">Save</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {assumptions.items.map((item) => (
                        <tr key={item.key} className="border-b border-mist/60">
                          <td className="py-2 pr-4 font-mono text-xs">{item.key}</td>
                          <td className="py-2 pr-4">
                            {item.label}
                            {item.description ? <p className="text-[11px] font-normal text-graphite">{item.description}</p> : null}
                          </td>
                          <td className="py-2 pr-4 text-graphite">{item.unit ?? "—"}</td>
                          <td className="py-2 pr-4">
                            {isAdmin ? (
                              <form method="post" action="/api/admin/finance/assumptions" className="flex items-center gap-2">
                                <input type="hidden" name="key" value={item.key} />
                                <input
                                  name="value"
                                  defaultValue={String(item.value)}
                                  inputMode={item.unit === "usd_cents" ? "numeric" : "text"}
                                  className="w-28 rounded-lg border border-silver/60 px-2 py-1.5 text-sm"
                                  aria-label={`Value for ${item.key}`}
                                />
                                <input type="hidden" name="label" value={item.label} />
                                <input type="hidden" name="unit" value={item.unit ?? ""} />
                                <button className="min-h-8 rounded-full bg-lime px-3 text-xs font-bold text-ink">Save</button>
                              </form>
                            ) : (
                              <span className="font-semibold">{String(item.value)}</span>
                            )}
                          </td>
                          <td className="py-2 pr-4 text-xs text-graphite">{item.source === "db" ? day(item.updatedAt) : "default"}</td>
                          {isAdmin && <td className="py-2 text-xs text-graphite">{item.source === "db" ? "saved" : "default"}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {isAdmin && (
                <form method="post" action="/api/admin/finance/assumptions" className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-silver/60 p-4">
                  <p className="w-full text-xs font-bold uppercase tracking-wider text-graphite">Custom assumption (key must start kiosk. or placement.)</p>
                  <label className="text-xs font-semibold">Key<input name="key" required placeholder="kiosk.foo_cost_cents" className="mt-1 block w-56 rounded-lg border border-silver/60 px-3 py-2" /></label>
                  <label className="text-xs font-semibold">Value<input name="value" required placeholder="0" className="mt-1 block w-32 rounded-lg border border-silver/60 px-3 py-2" /></label>
                  <label className="text-xs font-semibold">Label<input name="label" placeholder="optional" className="mt-1 block w-44 rounded-lg border border-silver/60 px-3 py-2" /></label>
                  <label className="text-xs font-semibold">Unit<input name="unit" placeholder="usd_cents" className="mt-1 block w-28 rounded-lg border border-silver/60 px-3 py-2" /></label>
                  <button className="min-h-10 rounded-full border border-ink px-5 text-sm font-bold">Upsert</button>
                </form>
              )}
            </section>

            <p className="text-xs text-graphite">
              Looking for venue placement scenarios? <Link href="/admin/opportunities" className="font-bold text-forest underline">Venue opportunities →</Link>
            </p>
          </>
        )}
      </div>
    </AdminGate>
  );
}
