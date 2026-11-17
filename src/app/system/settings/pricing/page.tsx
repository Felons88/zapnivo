export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { PRICING_SELECT } from "@/lib/billing";
import { fmt } from "@/lib/pricing";
import { PricingEditor } from "./PricingEditor";

export const metadata: Metadata = { title: "Settings — Pricing" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }) : "—";

type Row = {
  id: string; approved: boolean; first_hour_cents: number; additional_hour_cents: number;
  first_24h_cap_cents: number; additional_day_cents: number | null;
  non_return_max_cents: number; non_return_after_hours: number;
  hold_cents: number | null;
  effective_at: string | null;
};

export default async function PricingSettingsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.flags.manage");

  const { data } = db
    ? await db.from("pricing_versions").select(`${PRICING_SELECT},effective_at`)
        .order("effective_at", { ascending: false, nullsFirst: false }).limit(10)
    : { data: null };
  const rows = (data ?? []) as unknown as Row[];
  const current = rows[0] ?? null;

  return (
    <SystemGate perm="system.flags.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Settings</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Rental pricing</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Checkout quotes read the latest <code className="font-mono text-xs">pricing_versions</code> row
            by <code className="font-mono text-xs">effective_at</code> — rentals lock the version ID at checkout.
            Saving here <strong className="text-slate-200">creates a new version</strong>; existing rows are
            never mutated, so in-flight and past rentals keep the rates they agreed to. Every write is audited.
          </p>
        </div>

        {!db || !current ? (
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-6">
            <p className="text-sm text-slate-400">{!db ? "Backend not configured — pricing unavailable." : "No pricing versions exist yet."}</p>
          </section>
        ) : (
          <>
            <PricingEditor current={current} canManage={canManage} />
            <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
              <table className="w-full min-w-[860px] text-left text-xs">
                <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{["Version", "First hour", "Extra hour", "Hold", "24h cap", "Non-return", "Deadline", "Approved", "Effective"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} className={`border-b border-white/5 last:border-0 ${i === 0 ? "bg-lime/[0.04]" : ""}`}>
                      <td className="px-4 py-2.5 font-mono font-bold text-slate-200">{r.id}{i === 0 && <span className="ml-2 rounded-full bg-lime/15 px-2 py-0.5 text-[9px] text-lime ring-1 ring-lime/30">live</span>}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-300">{fmt(r.first_hour_cents)}</td>
                      <td className="px-4 py-2.5 font-mono text-lime">{fmt(r.additional_hour_cents)}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-300">{r.hold_cents !== null ? fmt(r.hold_cents) : `${fmt(r.non_return_max_cents)} (legacy)`}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-400">{fmt(r.first_24h_cap_cents)}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-300">{fmt(r.non_return_max_cents)}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-300">{r.non_return_after_hours}h</td>
                      <td className="px-4 py-2.5"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${r.approved ? "bg-lime/15 text-lime ring-lime/30" : "bg-amber-500/15 text-amber-300 ring-amber-400/30"}`}>{r.approved ? "approved" : "proposed"}</span></td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-slate-500">{when(r.effective_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            {!canManage && <p className="text-xs text-slate-500">Your role can view pricing but not edit it (requires system.flags.manage).</p>}
          </>
        )}
      </div>
    </SystemGate>
  );
}
