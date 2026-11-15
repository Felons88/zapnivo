export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { getSessionUser } from "@/lib/auth";
import { parsePeriodDays, periodWindow } from "@/lib/admin-finance";
import { fmt } from "@/lib/pricing";
import { loadRevenueAssurance, type AssuranceCheck, type AssuranceSeverity } from "@/lib/revenue-assurance";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Revenue assurance", robots: { index: false, follow: false } };

const DAY_LABEL: Record<number, string> = { 7: "7 days", 30: "30 days", 90: "90 days" };

const money = (c: number | null) => (c == null ? "—" : fmt(c));
const SEV_ORDER: Record<AssuranceSeverity, number> = { critical: 0, warning: 1, info: 2 };
const SEV_STYLE: Record<AssuranceSeverity, string> = {
  critical: "bg-red-100 text-red-800", warning: "bg-gold/30 text-ink", info: "bg-mist text-graphite",
};
const CHECK_LABEL: Record<string, string> = {
  captured_without_entitlement: "Captured payments without an entitled rental",
  duplicate_captures: "Duplicate captures per rental",
  missing_settlement: "Missing settlement coverage",
  unexpected_refund: "Unexpected refunds",
  commission_mismatch: "Commission ledger mismatches (sampled)",
  missing_payout_reference: "Paid payouts missing provider reference",
};

function ExceptionsCard({ checks }: { checks: AssuranceCheck[] }) {
  const all = checks.flatMap((c) => c.items.map((e) => ({ ...e, check: c.kind })));
  all.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.kind.localeCompare(b.kind));
  const unavailable = checks.filter((c) => c.status === "unavailable");
  const shown = all.slice(0, 200);

  return (
    <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
      <div className="border-b border-mist px-6 py-4">
        <h2 className="font-display text-lg font-bold">Reconciliation exception queue</h2>
        <p className="mt-1 text-xs text-graphite">
          {all.length} exception{all.length === 1 ? "" : "s"} across {checks.filter((c) => c.status === "ok").length} completed check{checks.filter((c) => c.status === "ok").length === 1 ? "" : "s"}
          {all.length > shown.length ? ` — showing first ${shown.length}` : ""}.
        </p>
      </div>
      {unavailable.length > 0 && (
        <div className="border-b border-mist bg-gold/20 px-6 py-3 text-xs text-graphite">
          {unavailable.map((c) => (
            <p key={c.kind}><span className="font-bold">{CHECK_LABEL[c.kind] ?? c.label}:</span> unavailable{c.reason ? ` — ${c.reason}` : ""}.</p>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="px-6 py-10 text-sm text-graphite">
          {unavailable.length > 0 ? "No exceptions from the checks that could run." : "No reconciliation exceptions found in this window."}
        </p>
      ) : (
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
            <tr>{["Severity", "Check", "Entity", "Detail", ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
          </thead>
          <tbody>
            {shown.map((e, i) => (
              <tr key={`${e.kind}-${e.entityId}-${i}`} className="border-b border-mist/60 last:border-0">
                <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold uppercase ${SEV_STYLE[e.severity]}`}>{e.severity}</span></td>
                <td className="px-4 py-3 text-graphite">{CHECK_LABEL[e.kind] ?? e.kind}</td>
                <td className="px-4 py-3 font-bold">{e.label}</td>
                <td className="px-4 py-3 text-graphite">{e.detail}</td>
                <td className="px-4 py-3"><Link href={e.href} className="text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Open →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default async function RevenueAssurancePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: raw } = await searchParams;
  const days = parsePeriodDays(raw);
  const me = await getSessionUser();
  const db = serviceClient();
  const window = periodWindow(days);
  let data: Awaited<ReturnType<typeof loadRevenueAssurance>> | null = null;
  let loadError: string | null = null;
  if (db) {
    try { data = await loadRevenueAssurance(db, window); }
    catch (e) { loadError = e instanceof Error ? e.message : "Failed to load revenue assurance data."; }
  }
  const m = data?.metrics ?? null;
  const checks = data?.checks ?? [];

  return (
    <AdminGate title="Revenue assurance" nav="revenueAssurance">
      {me?.role !== "admin" ? (
        <EmptyCard title="Admins only">Revenue assurance is restricted to admin accounts.</EmptyCard>
      ) : !db ? (
        <EmptyCard title="Revenue data not connected">Connect Supabase to run revenue assurance checks.</EmptyCard>
      ) : loadError ? (
        <EmptyCard title="Couldn't load revenue assurance data">{loadError}</EmptyCard>
      ) : !m ? (
        <EmptyCard title="Revenue data not connected">Connect Supabase to run revenue assurance checks.</EmptyCard>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-extrabold uppercase tracking-wider text-graphite">Period</span>
            {([7, 30, 90] as const).map((d) => (
              <Link key={d} href={`/admin/revenue?days=${d}`}
                className={`rounded-full px-4 py-1.5 text-sm font-bold ${d === days ? "bg-ink text-white" : "bg-white text-graphite border border-mist hover:text-ink"}`}>
                {DAY_LABEL[d]}
              </Link>
            ))}
          </div>

          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Gross captured" value={money(m.grossCapturedCents)} sub="Payments captured in window, before refunds" />
            <Metric label="Refunds issued" value={money(m.totalRefundedCents)} sub="Refund records created in window" />
            <Metric label="Chargebacks" value={m.chargebackCount == null ? "—" : `${m.chargebackCount}`}
              sub={m.chargebackCents != null ? `${fmt(m.chargebackCents)} open + lost · ${m.chargebacksWonCount ?? 0} won` : "Disputes unavailable"} />
            <Metric label="Est. Stripe fees" value={money(m.estimatedStripeFeesCents)} sub="Estimate · 2.9% + $0.30 per capture" />
            <Metric label="Net proceeds" value={money(m.netProceedsCents)} sub="Captured − refunds − est. fees − lost chargebacks" />
            <Metric label="Commission accrued" value={money(m.commissionAccruedCents)} sub="Ledgers overlapping window" />
            <Metric label="Commission paid" value={money(m.commissionPaidCents)} sub="Paid payouts on those ledgers" />
            <Metric label="Commission outstanding" value={money(m.commissionOutstandingCents)} sub={`${m.payoutScheduledCount ?? "—"} payout${m.payoutScheduledCount === 1 ? "" : "s"} scheduled/approved`} />
          </section>

          <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Definitions</h2>
            <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
              <div><dt className="font-bold">Captured</dt><dd className="text-graphite">A payment with a real captured amount in the window. Authorizations and released holds never count.</dd></div>
              <div><dt className="font-bold">Refunds issued</dt><dd className="text-graphite">Refund rows created in the window — not the same as a payment&apos;s cumulative refunded amount.</dd></div>
              <div><dt className="font-bold">Chargebacks</dt><dd className="text-graphite">Disputes opened in the window. &quot;Open + lost&quot; counts everything not yet won; only lost amounts reduce net proceeds.</dd></div>
              <div><dt className="font-bold">Est. Stripe fees</dt><dd className="text-graphite">An estimate (2.9% + $0.30 per captured payment), not actual Stripe billing data.</dd></div>
              <div><dt className="font-bold">Net proceeds</dt><dd className="text-graphite">Gross captured − refunds issued − estimated Stripe fees − lost chargeback amounts.</dd></div>
              <div><dt className="font-bold">Commission accrued / paid / outstanding</dt><dd className="text-graphite">Accrued = commission_cents on ledgers whose month overlaps the window. Paid = payout_records marked paid against those ledgers. Outstanding = accrued minus paid, floored at zero per ledger. Payouts are recorded manually — the app never moves money.</dd></div>
              <div><dt className="font-bold">Settled</dt><dd className="text-graphite">A capture is treated as settlement-covered when a commission ledger exists for its venue + capture month and that ledger has at least one payout record. This is an approximation — it does not prove funds reached the venue.</dd></div>
            </dl>
          </section>

          <ExceptionsCard checks={checks} />

          <p className="text-xs text-graphite">
            Commission checks are a sampled recomputation against agreed rates — ledgers for venues without a commission rate are skipped, not flagged.
            Settlement coverage is approximate (venue + month granularity). Any check that could not run is marked unavailable above rather than reported as zero.
            Raw data: <code className="rounded bg-mist px-1">GET /api/admin/revenue?days={days}</code>
          </p>
        </div>
      )}
    </AdminGate>
  );
}
