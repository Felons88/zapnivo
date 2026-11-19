export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser } from "@/lib/auth";
import { previousPeriod } from "@/lib/ledgers";
import { fmt } from "@/lib/pricing";
import { loadSettlementBoard, PAYOUT_METHODS, type SettlementRow, type SettlementState } from "@/lib/settlement";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Ledgers & payouts", robots: { index: false, follow: false } };

const STATE_TONE: Record<SettlementState, "mist" | "lime" | "gold" | "red" | "ink" | "cyan"> = {
  unbilled: "mist", accrued: "cyan", scheduled: "cyan", approved: "gold", paid: "lime", failed: "red", cancelled: "mist",
};
const PAY_TONE = { paid: "lime", approved: "gold", scheduled: "cyan", failed: "red", cancelled: "mist" } as const;
const month = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");

/** Last 12 calendar months (YYYY-MM), newest first, for the period selector. */
const recentPeriods = () => {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 12; i++) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
};

const agreementLabel = (r: SettlementRow) => {
  const a = r.agreement;
  if (!a) return "no agreement rate";
  const pct = a.pct == null ? "no rate" : `${a.pct}%`;
  const win = [a.effectiveFrom && `from ${a.effectiveFrom}`, a.effectiveTo && `to ${a.effectiveTo}`].filter(Boolean).join(" ");
  return `${pct}${win ? ` · ${win}` : ""}`;
};

export default async function Payouts({ searchParams }: { searchParams: Promise<{ gen?: string; norate?: string; locked?: string; period?: string }> }) {
  const sp = await searchParams;
  const me = await getSessionUser();
  const isAdmin = me?.role === "admin";
  const db = serviceClient();
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.period ?? "") ? sp.period! : previousPeriod();
  const rows = db ? await loadSettlementBoard(db, period) : [];
  const input = "min-h-10 rounded-lg border border-silver/70 px-3 text-sm";

  const allPayouts = rows.flatMap((r) => r.payouts);
  const cents = (s: SettlementState) => allPayouts.filter((p) => p.status === s).reduce((a, p) => a + p.amountCents, 0);
  const outstanding = rows.filter((r) => ["accrued", "scheduled", "approved", "failed"].includes(r.state)).reduce((a, r) => a + (r.commissionCents ?? 0) - r.payouts.filter((p) => p.status === "paid").reduce((x, p) => x + p.amountCents, 0), 0);

  return (
    <AdminGate title="Settlement board" nav="payouts">
      {!db ? <EmptyCard title="Finance data not connected">Connect Supabase.</EmptyCard> : (
        <div className="space-y-4">
          {sp.gen != null && <p className="rounded-xl bg-lime px-4 py-2.5 text-sm font-bold text-ink">Generated {sp.gen} ledger(s){Number(sp.norate) > 0 ? ` · ${sp.norate} venue(s) skipped — no private commission rate on their agreement` : ""}{Number(sp.locked) > 0 ? ` · ${sp.locked} locked (payout exists)` : ""}.</p>}

          <section className="grid gap-4 sm:grid-cols-3">
            <Metric label="Awaiting payout" value={fmt(outstanding)} sub={`${month(`${period}-01`)} · scheduled + approved + accrued commission`} />
            <Metric label="Paid (recorded)" value={fmt(cents("paid"))} sub="Paid externally — references on file" />
            <Metric label="Venues" value={rows.length} sub={`${rows.filter((r) => r.state === "unbilled").length} without a ledger`} />
          </section>

          <section className="rounded-2xl border border-mist bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-bold">Settlement period</h2>
                <p className="mt-1 text-xs text-graphite">Gross = captured minus refunded payments at each venue&apos;s stations that month. Commission uses the private <code>commission_pct</code> on the partner agreement — venues without one are skipped, never defaulted. Ledgers with a payout are locked. Runs automatically on the 1st for the prior month.</p>
              </div>
              <form method="get" className="flex items-end gap-2">
                <div><label htmlFor="period" className="mb-1 block text-xs font-bold">Period</label>
                  <select id="period" name="period" defaultValue={period} className={input}>
                    {recentPeriods().map((p) => <option key={p} value={p}>{month(`${p}-01`)}</option>)}
                  </select>
                </div>
                <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">View</button>
              </form>
            </div>
            <form method="post" action="/api/admin/payouts" className="mt-4 flex flex-wrap items-end gap-3 border-t border-mist pt-4">
              <input type="hidden" name="action" value="generate_ledgers" />
              <div><label htmlFor="g-period" className="mb-1 block text-xs font-bold">Generate ledgers for</label><input id="g-period" name="period" required pattern="\d{4}-(0[1-9]|1[0-2])" defaultValue={period} className={input} /></div>
              <button className="min-h-10 rounded-full bg-mist px-5 text-sm font-bold hover:bg-lime">Generate</button>
            </form>
          </section>

          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-4 py-4"><h2 className="font-display text-lg font-bold">Venues — {month(`${period}-01`)}</h2></div>
            {rows.length === 0 ? <p className="px-4 py-8 text-sm text-graphite">No venues found.</p> : (
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Venue", "Organization", "Gross", "Commission", "Agreement", "Payout", "State", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const payout = r.payouts.find((p) => p.status === r.state) ?? r.payouts[0] ?? null;
                    return (
                      <tr key={r.venueId} className="border-b border-mist/70 align-top last:border-0">
                        <td className="px-4 py-3 font-bold">{r.venueName}{r.statementPath && <> · <a href={r.statementPath} className="text-xs font-bold text-forest underline">statement</a></>}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{r.organizationName ?? "—"}</td>
                        <td className="px-4 py-3">{r.grossCents == null ? "—" : fmt(r.grossCents)}</td>
                        <td className="px-4 py-3 font-display font-bold">{r.commissionCents == null ? "—" : fmt(r.commissionCents)}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{agreementLabel(r)}{r.agreement?.signedAt ? ` · signed ${r.agreement.signedAt}` : ""}</td>
                        <td className="px-4 py-3">
                          {payout ? (
                            <div className="space-y-1 text-xs">
                              <Pill tone={PAY_TONE[payout.status]}>{payout.status}</Pill>
                              <p className="font-bold">{fmt(payout.amountCents)}{payout.method ? ` · ${payout.method}` : ""}</p>
                              {payout.providerReference && <p className="text-graphite">ref {payout.providerReference}</p>}
                              {payout.approvedAt && <p className="text-graphite">approved {day(payout.approvedAt)}</p>}
                              {payout.paidAt && <p className="text-graphite">paid {day(payout.paidAt)}</p>}
                            </div>
                          ) : <span className="text-xs text-graphite">none</span>}
                        </td>
                        <td className="px-4 py-3"><Pill tone={STATE_TONE[r.state]}>{r.state}</Pill></td>
                        <td className="px-4 py-3">
                          {isAdmin && r.state === "accrued" && (r.commissionCents ?? 0) > 0 && (
                            <form method="post" action="/api/admin/payouts" className="flex items-center gap-2">
                              <input type="hidden" name="action" value="schedule_payout" /><input type="hidden" name="ledger_id" value={r.ledgerId ?? ""} />
                              <select name="method" className="min-h-8 rounded-lg border border-silver/70 px-2 text-xs" defaultValue="">
                                <option value="">method…</option>
                                {PAYOUT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                              </select>
                              <button className="min-h-8 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Schedule</button>
                            </form>
                          )}
                          {isAdmin && payout?.status === "scheduled" && (
                            <div className="flex flex-col gap-2">
                              <form method="post" action="/api/admin/payouts"><input type="hidden" name="action" value="approve_payout" /><input type="hidden" name="payout_id" value={payout.id} /><button className="min-h-8 rounded-full bg-ink px-3 text-xs font-bold text-white">Approve</button></form>
                              <form method="post" action="/api/admin/payouts"><input type="hidden" name="action" value="cancel_payout" /><input type="hidden" name="payout_id" value={payout.id} /><button className="min-h-8 rounded-full border border-silver/60 px-3 text-xs font-bold">Cancel</button></form>
                            </div>
                          )}
                          {isAdmin && payout?.status === "approved" && (
                            <div className="space-y-2">
                              <form method="post" action="/api/admin/payouts" className="flex flex-wrap items-center gap-1.5">
                                <input type="hidden" name="action" value="mark_payout" /><input type="hidden" name="payout_id" value={payout.id} /><input type="hidden" name="to" value="paid" />
                                <input name="provider_reference" required placeholder="transfer ref" className="min-h-8 w-28 rounded-lg border border-silver/70 px-2 text-xs" />
                                <select name="method" required className="min-h-8 rounded-lg border border-silver/70 px-1.5 text-xs" defaultValue={payout.method ?? ""}>
                                  <option value="" disabled>method</option>
                                  {PAYOUT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                                </select>
                                <button className="min-h-8 rounded-full bg-lime px-3 text-xs font-bold text-ink">Mark paid</button>
                              </form>
                              <div className="flex gap-2">
                                <form method="post" action="/api/admin/payouts"><input type="hidden" name="action" value="mark_payout" /><input type="hidden" name="payout_id" value={payout.id} /><input type="hidden" name="to" value="failed" /><button className="min-h-8 rounded-full border border-silver/60 px-3 text-xs font-bold">Mark failed</button></form>
                                <form method="post" action="/api/admin/payouts"><input type="hidden" name="action" value="cancel_payout" /><input type="hidden" name="payout_id" value={payout.id} /><button className="min-h-8 rounded-full border border-silver/60 px-3 text-xs font-bold">Cancel</button></form>
                              </div>
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
          <p className="text-xs text-graphite"><Link href="/admin/onboarding" className="font-bold underline">Partner onboarding</Link> · <Link href="/admin/sla" className="font-bold underline">Partner support SLA</Link> · <Link href="/admin/partners" className="font-bold underline">Partner statements</Link></p>
          <p className="text-xs text-graphite">Payouts are recorded manually after you pay the venue externally (ACH, check, etc.). The app tracks the approval trail and the external reference — it never executes a transfer.</p>
        </div>
      )}
    </AdminGate>
  );
}
