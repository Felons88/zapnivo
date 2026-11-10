export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { defaultCtx } from "@/lib/helpdesk/service";
import { SLA_HOURS } from "@/lib/helpdesk/sla";
import { summarizePartnerSla } from "@/lib/partner-ops";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Partner support SLA", robots: { index: false, follow: false } };
const hrs = (h: number | null) => (h == null ? "—" : `${h}h`);

export default async function SlaPage() {
  const ctx = await defaultCtx();
  const tickets = ctx ? await ctx.repo.listTickets({ queue: "partner", limit: 1000 }) : [];
  const s = summarizePartnerSla(tickets);
  const db = serviceClient();
  const ids = s.perOrg.map((o) => o.orgId).filter((x): x is string => !!x);
  const { data: orgRows } = db && ids.length ? await db.from("organizations").select("id,name").in("id", ids) : { data: [] };
  const names = new Map(((orgRows ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
  return (
    <AdminGate title="Partner support SLA" nav="sla">
      {!ctx ? <EmptyCard title="Support system not connected">Connect Supabase to see SLA data.</EmptyCard> : (
        <div className="space-y-6">
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Partner tickets" value={s.total} sub={`${s.open} open`} />
            <Metric label="Avg first response" value={hrs(s.avgFirstResponseHours)} sub={`${s.responded} responded`} />
            <Metric label="Avg resolution" value={hrs(s.avgResolutionHours)} sub={`${s.resolved} resolved`} />
            <Metric label="Breaches" value={s.firstResponseBreaches + s.resolutionBreaches} sub={`${s.firstResponseBreaches} first response · ${s.resolutionBreaches} resolution`} />
          </section>
          <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Internal targets</h2>
            <p className="mt-2 text-sm text-graphite">{(Object.entries(SLA_HOURS) as [string, { first: number; resolve: number }][]).map(([p, v]) => `${p}: ${v.first}h first response, ${v.resolve}h resolution`).join(" · ")}. Internal only; not published to partners.</p>
          </section>
          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">By organization</h2></div>
            {s.perOrg.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No partner tickets yet.</p> : (
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Organization", "Tickets", "Open", "Breached"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>{s.perOrg.map((o) => (
                  <tr key={o.orgId ?? "none"} className="border-b border-mist/70 last:border-0">
                    <td className="px-4 py-3 font-bold">{o.orgId ? names.get(o.orgId) ?? "Unknown organization" : "Unassigned"}</td>
                    <td className="px-4 py-3">{o.total}</td><td className="px-4 py-3">{o.open}</td><td className="px-4 py-3 font-bold">{o.breaches}</td>
                  </tr>))}</tbody>
              </table>
            )}
          </section>
          <p className="text-xs text-graphite"><Link href="/admin/onboarding" className="font-bold underline">Partner onboarding</Link> · <Link href="/admin/support" className="font-bold underline">Support inbox</Link></p>
        </div>
      )}
    </AdminGate>
  );
}
