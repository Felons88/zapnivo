export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { getSessionUser } from "@/lib/auth";
import { computeSummary, fetchFinanceData, groupByVenue, parsePeriodDays, periodWindow } from "@/lib/admin-finance";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Finance", robots: { index: false, follow: false } };

const DAY_LABEL: Record<number, string> = { 7: "7 days", 30: "30 days", 90: "90 days" };

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: raw } = await searchParams;
  const days = parsePeriodDays(raw);
  const me = await getSessionUser();
  const db = serviceClient();
  const window = periodWindow(days);
  let data: Awaited<ReturnType<typeof fetchFinanceData>> | null = null;
  let loadError: string | null = null;
  if (db) {
    try { data = await fetchFinanceData(db, window); }
    catch (e) { loadError = e instanceof Error ? e.message : "Failed to load finance data."; }
  }
  const summary = data ? computeSummary(data, window) : null;
  const venues = data ? groupByVenue(data) : [];

  return (
    <AdminGate title="Finance" nav="finance">
      {me?.role !== "admin" ? (
        <EmptyCard title="Admins only">Revenue reporting is restricted to admin accounts.</EmptyCard>
      ) : !db ? (
        <EmptyCard title="Finance data not connected">Connect Supabase to view revenue reporting.</EmptyCard>
      ) : loadError ? (
        <EmptyCard title="Couldn't load finance data">{loadError}</EmptyCard>
      ) : !summary ? (
        <EmptyCard title="Finance data not connected">Connect Supabase to view revenue reporting.</EmptyCard>
      ) : (
        <div className="space-y-6">
          {/* Period selector */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-extrabold uppercase tracking-wider text-graphite">Period</span>
            {([7, 30, 90] as const).map((d) => (
              <Link key={d} href={`/admin/finance?days=${d}`}
                className={`rounded-full px-4 py-1.5 text-sm font-bold ${d === days ? "bg-ink text-white" : "bg-white text-graphite border border-mist hover:text-ink"}`}>
                {DAY_LABEL[d]}
              </Link>
            ))}
          </div>

          {/* Revenue categories */}
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Rental revenue" value={fmt(summary.rentalRevenueCents)} sub={`${summary.rentalPaymentCount} captured payment${summary.rentalPaymentCount === 1 ? "" : "s"}`} />
            <Metric label="Non-return fees" value={fmt(summary.nonReturnFeeCents)} sub={`${summary.nonReturnFeePaymentCount} captured`} />
            <Metric label="Refunds" value={fmt(summary.refundsCents)} sub={`${summary.refundCount} refund${summary.refundCount === 1 ? "" : "s"} issued`} />
            <Metric label="Stripe fees" value={fmt(summary.stripeFeesCents)} sub={summary.stripeFeesEstimated ? "Estimate · 2.9% + $0.30" : "Actual (billing ledger)"} />
            <Metric label="SMS costs" value={summary.smsCostCents != null ? fmt(summary.smsCostCents) : "Not tracked"}
              sub={`${summary.smsOutboundCount} outbound · ${summary.smsCostTracked ? "rate configured" : "set system_config.sms_outbound_cost_cents"}`} />
            <Metric label="Venue revenue share" value={fmt(summary.venueShareCents)} sub={`${summary.venuesWithRate} venue${summary.venuesWithRate === 1 ? "" : "s"} with a commission rate`} />
            <Metric label="Net platform revenue" value={fmt(summary.netPlatformCents)} sub="After fees, refunds, SMS & venue share" />
            <Metric label="Gross captured" value={fmt(summary.grossCapturedCents)} sub="Before refunds" />
          </section>

          {/* Payouts */}
          <section className="grid gap-4 sm:grid-cols-3">
            <Metric label="Payouts scheduled" value={fmt(summary.payouts.scheduledCents)} sub={`${summary.payouts.scheduledCount} awaiting payment`} />
            <Metric label="Payouts paid" value={fmt(summary.payouts.paidCents)} sub={`${summary.payouts.paidCount} completed`} />
            <Metric label="Reporting window" value={DAY_LABEL[days]} sub={`${new Date(summary.period.start).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} → ${new Date(summary.period.end).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`} />
          </section>

          {/* By venue */}
          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-mist px-6 py-4">
              <h2 className="font-display text-lg font-bold">By venue</h2>
              <Link href="/admin/payouts" className="text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Ledgers &amp; payouts →</Link>
            </div>
            {venues.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No captured payments in this period.</p>
            ) : (
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Venue", "Rentals", "Captured", "Refunds", "Net", "Stripe fees (est.)", "Venue share"].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {venues.map((v) => (
                    <tr key={v.venueId} className="border-b border-mist/60 last:border-0">
                      <td className="px-4 py-3 font-bold">{v.venueName}</td>
                      <td className="px-4 py-3 text-graphite">{v.rentalsCount}</td>
                      <td className="px-4 py-3 font-bold">{fmt(v.capturedCents)}</td>
                      <td className="px-4 py-3 text-graphite">{v.refundedCents ? fmt(v.refundedCents) : "—"}</td>
                      <td className="px-4 py-3 font-bold">{fmt(v.netCents)}</td>
                      <td className="px-4 py-3 text-graphite">{fmt(v.stripeFeesCents)}</td>
                      <td className="px-4 py-3 text-graphite">{v.venueShareCents != null ? fmt(v.venueShareCents) : "No rate"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p className="text-xs text-graphite">
            Only captured payments count as revenue — authorizations and released holds are excluded. Non-return fees are captured payments on rentals in a non-return state.
            Stripe fees are an estimate (2.9% + $0.30 per capture) unless the billing ledger supplies actuals. SMS cost shows &quot;Not tracked&quot; until a per-message rate is set in system_config.
            Payout totals are all-time scheduled/paid records, not period-bound.
          </p>
        </div>
      )}
    </AdminGate>
  );
}
