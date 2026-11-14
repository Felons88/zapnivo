export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { PartnerGate } from "@/components/PartnerShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { loadOrgReport } from "@/lib/partner-ops-data";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Performance", robots: { index: false, follow: false } };

const deltaLabel = (v: number | null) => (v == null ? "no prior period" : `${v > 0 ? "+" : ""}${v}% vs prior 30d`);
const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export default async function PartnerPerformance() {
  return (
    <PartnerGate title="Performance" nav="performance">
      {async ({ user }) => {
        const orgId = user.organizationId;
        const db = serviceClient();
        const report = orgId && db ? await loadOrgReport(db, orgId) : null;

        if (!report) {
          return <EmptyCard title="No venue linked yet">Your account isn't attached to a venue organization yet, so there's no performance data to show. Once your agreement is active and a station is installed, rentals, revenue and device health appear here.</EmptyCard>;
        }

        const { current, prior, deltas, commission, payouts, openTickets, devices, venues } = report;
        const hasActivity = current.rentals > 0 || current.revenueCents > 0 || commission.periods > 0 || devices.total > 0;

        return (
          <div className="space-y-6">
            <section aria-label="Last 30 days" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Rentals (30 days)" value={current.rentals} sub={deltaLabel(deltas.rentalsPct)} />
              <Metric label="Completed rentals" value={current.completed} sub={`${current.utilizationPct ?? "—"}% utilization · ${deltaLabel(deltas.completedPct)}`} />
              <Metric label="Net revenue (30 days)" value={fmt(current.revenueCents)} sub={deltaLabel(deltas.revenuePct)} />
              <Metric label="Payments (30 days)" value={current.payments} />
            </section>

            <section aria-label="Earnings and payouts" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Commission to date" value={fmt(commission.commissionCents)} sub={commission.latestPeriod ? `Latest statement ${month(commission.latestPeriod)}` : "No statements yet"} />
              <Metric label="Gross to date" value={fmt(commission.grossCents)} sub={`${commission.periods} statement${commission.periods === 1 ? "" : "s"}`} />
              <Metric label="Scheduled payout" value={fmt(payouts.scheduledCents)} sub={payouts.failed ? `${payouts.failed} failed — see payouts` : payouts.paidCents ? `${fmt(payouts.paidCents)} paid to date` : "No payouts yet"} />
              <Metric label="Open requests" value={openTickets} sub="With Zapnivo support" />
            </section>

            {!hasActivity && (
              <EmptyCard title="No activity yet">Once your station is live and renters start using it, rentals, revenue, commissions and device health show up here. <Link href="/partners/demo" className="font-bold underline">Preview a populated portal →</Link></EmptyCard>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
              <section aria-label="Devices" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Device health</h2>
                {devices.total === 0 ? (
                  <p className="mt-4 text-sm text-graphite">No devices registered to your venues yet.</p>
                ) : (
                  <>
                    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="rounded-xl bg-mist/50 p-3"><p className="text-2xl font-display font-bold">{devices.online}</p><p className="text-xs font-bold uppercase tracking-wider text-graphite">Online</p></div>
                      <div className="rounded-xl bg-mist/50 p-3"><p className="text-2xl font-display font-bold">{devices.stale}</p><p className="text-xs font-bold uppercase tracking-wider text-graphite">Stale</p></div>
                      <div className="rounded-xl bg-mist/50 p-3"><p className="text-2xl font-display font-bold">{devices.inactive}</p><p className="text-xs font-bold uppercase tracking-wider text-graphite">Not active</p></div>
                      <div className="rounded-xl bg-mist/50 p-3"><p className="text-2xl font-display font-bold">{devices.total}</p><p className="text-xs font-bold uppercase tracking-wider text-graphite">Total</p></div>
                    </div>
                    <p className="mt-3 text-xs text-graphite">Online = heartbeat within 24h. Stale = active status but no recent heartbeat. Not active = provisioning, maintenance or suspended.</p>
                  </>
                )}
              </section>

              <section aria-label="Venues and export" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Your venues</h2>
                {venues.length === 0 ? (
                  <p className="mt-4 text-sm text-graphite">No venues registered yet.</p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {venues.map((v) => (
                      <li key={v.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="font-bold">{v.name}</span>
                        <Pill tone={v.published ? "lime" : "mist"}>{v.published ? "published" : "pending"}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-6 border-t border-mist pt-4">
                  <h3 className="text-sm font-bold">Reports</h3>
                  <p className="mt-1 text-xs text-graphite">Download your rentals for the last 12 months as CSV. Only your organization's stations are included.</p>
                  <a href="/api/partners/reports/rentals.csv" className="mt-3 inline-block rounded-lg bg-ink px-4 py-2 text-xs font-extrabold uppercase tracking-wider text-white hover:bg-forest">Download rentals CSV ↓</a>
                </div>
              </section>
            </div>

            <p className="text-sm text-graphite">
              Comparing the last 30 days to the prior 30 days. <Link href="/partners/payouts" className="font-bold underline">Payouts &amp; statements →</Link> · <Link href="/partners/support" className="font-bold underline">Support requests →</Link>
            </p>
          </div>
        );
      }}
    </PartnerGate>
  );
}
