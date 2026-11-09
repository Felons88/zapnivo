export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser } from "@/lib/auth";
import { previousPeriod } from "@/lib/ledgers";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Ledgers & payouts", robots: { index: false, follow: false } };
const PAY_TONE = { paid: "lime", scheduled: "cyan", failed: "red" } as const;
const month = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const one = <T,>(v: T | T[] | null) => (Array.isArray(v) ? v[0] : v);

export default async function Payouts({ searchParams }: { searchParams: Promise<{ gen?: string; norate?: string; locked?: string }> }) {
  const sp = await searchParams;
  const me = await getSessionUser();
  const isAdmin = me?.role === "admin";
  const db = serviceClient();
  const [ledgersRes, payoutsRes] = db ? await Promise.all([
    db.from("commission_ledgers").select("id,period,gross_cents,commission_cents,venues(name,organizations(name))").order("period", { ascending: false }).limit(300),
    db.from("payout_records").select("id,ledger_id,amount_cents,status,paid_at,created_at").limit(1000),
  ]) : [null, null];
  type L = { id: string; period: string; gross_cents: number; commission_cents: number; venues: { name: string; organizations: { name: string } | { name: string }[] | null } | { name: string; organizations: { name: string } | { name: string }[] | null }[] | null };
  const ledgers = (ledgersRes?.data ?? []) as unknown as L[];
  const payouts = (payoutsRes?.data ?? []) as { id: string; ledger_id: string; amount_cents: number; status: keyof typeof PAY_TONE; paid_at: string | null }[];
  const payBy = new Map(payouts.map((p) => [p.ledger_id, p]));
  const sum = (s: string) => payouts.filter((p) => p.status === s).reduce((a, p) => a + p.amount_cents, 0);
  const input = "min-h-10 rounded-lg border border-silver/70 px-3 text-sm";

  return (
    <AdminGate title="Ledgers & payouts" nav="partners">
      {!db ? <EmptyCard title="Finance data not connected">Connect Supabase.</EmptyCard> : (
        <div className="space-y-6">
          {sp.gen != null && <p className="rounded-xl bg-lime px-4 py-2.5 text-sm font-bold text-ink">Generated {sp.gen} ledger(s){Number(sp.norate) > 0 ? ` · ${sp.norate} venue(s) skipped — no private commission rate on their agreement` : ""}{Number(sp.locked) > 0 ? ` · ${sp.locked} locked (payout exists)` : ""}.</p>}
          <section className="grid gap-4 sm:grid-cols-3">
            <Metric label="Scheduled" value={fmt(sum("scheduled"))} sub="Awaiting payment" />
            <Metric label="Paid" value={fmt(sum("paid"))} />
            <Metric label="Ledgers" value={ledgers.length} />
          </section>

          <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Generate monthly ledgers</h2>
            <form method="post" action="/api/admin/payouts" className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="action" value="generate_ledgers" />
              <div><label htmlFor="g-period" className="mb-1 block text-xs font-bold">Period</label><input id="g-period" name="period" required pattern="\d{4}-(0[1-9]|1[0-2])" defaultValue={previousPeriod()} className={input} /></div>
              <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Generate</button>
            </form>
            <p className="mt-3 text-xs text-graphite">Gross = captured minus refunded payments at each venue&apos;s stations that month. Commission uses the private <code>commission_pct</code> on the partner agreement — venues without one are skipped, never defaulted. Ledgers with a payout are locked. Runs automatically on the 1st for the prior month.</p>
          </section>

          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Ledgers</h2></div>
            {ledgers.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No ledgers yet. Generate a period above once rentals are captured.</p> : (
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Period", "Venue", "Organization", "Gross", "Commission", "Payout", ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {ledgers.map((l) => {
                    const v = one(l.venues); const org = one(v?.organizations ?? null); const p = payBy.get(l.id);
                    return (
                      <tr key={l.id} className="border-b border-mist/70 last:border-0">
                        <td className="px-4 py-3 font-bold">{month(l.period)}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{v?.name ?? "—"}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{org?.name ?? "—"}</td>
                        <td className="px-4 py-3">{fmt(l.gross_cents)}</td>
                        <td className="px-4 py-3 font-display font-bold">{fmt(l.commission_cents)}</td>
                        <td className="px-4 py-3">{p ? <Pill tone={PAY_TONE[p.status]}>{p.status}</Pill> : <span className="text-xs text-graphite">none</span>}</td>
                        <td className="px-4 py-3">
                          {isAdmin && !p && l.commission_cents > 0 && <form method="post" action="/api/admin/payouts"><input type="hidden" name="action" value="schedule_payout" /><input type="hidden" name="ledger_id" value={l.id} /><button className="min-h-8 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Schedule</button></form>}
                          {isAdmin && p?.status === "scheduled" && (
                            <div className="flex gap-2">
                              {(["paid", "failed"] as const).map((to) => <form key={to} method="post" action="/api/admin/payouts"><input type="hidden" name="action" value="mark_payout" /><input type="hidden" name="payout_id" value={p.id} /><input type="hidden" name="to" value={to} /><button className={`min-h-8 rounded-full px-3 text-xs font-bold ${to === "paid" ? "bg-lime text-ink" : "border border-silver/60"}`}>Mark {to}</button></form>)}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
          <p className="text-xs text-graphite">Payouts are recorded manually after you pay the venue (ACH, check, etc.). The app tracks status and never claims an automated transfer.</p>
        </div>
      )}
    </AdminGate>
  );
}
