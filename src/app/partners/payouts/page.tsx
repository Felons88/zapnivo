export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { PartnerGate } from "@/components/PartnerShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { monthlyCommission } from "@/lib/partner-ops";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Payouts", robots: { index: false, follow: false } };
const PAY_TONE = { paid: "lime", scheduled: "cyan", failed: "red" } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const month = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", year: "numeric" });

export default async function Payouts() {
  return (
    <PartnerGate title="Payouts" nav="payouts">
      {async ({ user }) => {
        const orgId = user.organizationId;
        const db = serviceClient();
        const [ledgers, payouts] = orgId && db ? await Promise.all([
          db.from("commission_ledgers").select("id,period,gross_cents,commission_cents,venues!inner(name,organization_id)").eq("venues.organization_id", orgId).order("period", { ascending: false }).limit(60),
          db.from("payout_records").select("id,amount_cents,status,paid_at,created_at,commission_ledgers!inner(period,venues!inner(name,organization_id))").eq("commission_ledgers.venues.organization_id", orgId).order("created_at", { ascending: false }).limit(60),
        ]) : [{ data: null }, { data: null }];

        const ledgerRows = (ledgers?.data ?? []) as unknown as { id: string; period: string; gross_cents: number; commission_cents: number; venues: { name: string } | null }[];
        const payoutRows = (payouts?.data ?? []) as unknown as { id: string; amount_cents: number; status: keyof typeof PAY_TONE; paid_at: string | null; created_at: string; commission_ledgers: { period: string; venues: { name: string } | null } | null }[];
        const scheduled = payoutRows.filter((p) => p.status === "scheduled").reduce((a, p) => a + p.amount_cents, 0);
        const paidTotal = payoutRows.filter((p) => p.status === "paid").reduce((a, p) => a + p.amount_cents, 0);

        const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 5, 1)).toISOString().slice(0, 10);
        const { data: chartData } = orgId && db ? await db.from("commission_ledgers").select("period,commission_cents,venues!inner(organization_id)").eq("venues.organization_id", orgId).gte("period", since).limit(500) : { data: null };
        const bars = monthlyCommission((chartData ?? []) as { period: string; commission_cents: number }[]);
        const maxBar = Math.max(1, ...bars.map((b) => b.cents));

        return (
          <div className="space-y-6">
            <section aria-label="Commission by month" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Commission by month</h2>
              {bars.every((b) => b.cents === 0) ? (
                <p className="mt-3 text-sm text-graphite">No commission recorded in the last 6 months.</p>
              ) : (
                <svg role="img" aria-label={`Commission per month, last 6 months: ${bars.map((b) => `${b.label} ${fmt(b.cents)}`).join(", ")}`} viewBox="0 0 360 160" className="mt-4 w-full max-w-xl">
                  {bars.map((b, i) => {
                    const h = Math.round((b.cents / maxBar) * 110);
                    return (
                      <g key={b.key}>
                        <rect x={i * 60 + 12} y={125 - h} width={36} height={h} rx={4} className="fill-forest" />
                        <text x={i * 60 + 30} y={120 - h} textAnchor="middle" fontSize="10" className="fill-ink">{b.cents ? fmt(b.cents) : ""}</text>
                        <text x={i * 60 + 30} y={145} textAnchor="middle" fontSize="11" className="fill-graphite">{b.label}</text>
                      </g>
                    );
                  })}
                </svg>
              )}
            </section>

            <section aria-label="Payout summary" className="grid gap-4 sm:grid-cols-3">
              <Metric label="Scheduled" value={fmt(scheduled)} sub="Upcoming payout total" />
              <Metric label="Paid to date" value={fmt(paidTotal)} />
              <Metric label="Statements" value={ledgerRows.length} />
            </section>

            <section aria-label="Payout records" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Payouts</h2></div>
              {payoutRows.length === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No payouts yet. Statements appear here once commission ledgers are active.</p>
              ) : (
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Period", "Venue", "Amount", "Status", "Paid"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                  <tbody>
                    {payoutRows.map((p) => (
                      <tr key={p.id} className="border-b border-mist/70 last:border-0">
                        <td className="px-4 py-3 font-bold">{p.commission_ledgers?.period ? month(p.commission_ledgers.period) : "—"}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{p.commission_ledgers?.venues?.name ?? "—"}</td>
                        <td className="px-4 py-3 font-display font-bold">{fmt(p.amount_cents)}</td>
                        <td className="px-4 py-3"><Pill tone={PAY_TONE[p.status] ?? "mist"}>{p.status}</Pill></td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(p.paid_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section aria-label="Commission statements" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Monthly statements</h2></div>
              {ledgerRows.length === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No statements yet. Monthly gross and commission figures appear here once your station is live.</p>
              ) : (
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Period", "Venue", "Gross", "Commission"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                  <tbody>
                    {ledgerRows.map((l) => (
                      <tr key={l.id} className="border-b border-mist/70 last:border-0">
                        <td className="px-4 py-3 font-bold">{month(l.period)}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{l.venues?.name ?? "—"}</td>
                        <td className="px-4 py-3 font-semibold">{fmt(l.gross_cents)}</td>
                        <td className="px-4 py-3 font-semibold">{fmt(l.commission_cents)}</td>
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
