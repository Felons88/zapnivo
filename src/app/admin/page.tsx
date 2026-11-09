export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { humanDue } from "@/lib/helpdesk/sla";
import { fmt } from "@/lib/pricing";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false, follow: false } };

export default async function AdminDashboard() {
  const ctx = await defaultCtx();
  const m = ctx ? await computeMetrics(ctx.repo) : null;
  const recent = ctx
    ? (await ctx.repo.listTickets({ limit: 200 })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)
    : [];
  const now = new Date();

  return (
    <AdminGate title="Dashboard" nav="dashboard">
      {!m ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <EmptyCard title="Active stations"><p>No stations are registered yet. The first kiosk will appear here once provisioned.</p></EmptyCard>
          <EmptyCard title="Active rentals"><p>Rentals go live with the first station.</p></EmptyCard>
          <EmptyCard title="Revenue"><p>Revenue reporting activates with payment integration.</p></EmptyCard>
          <EmptyCard title="Open tickets"><p>New support tickets will appear here once Supabase is connected.</p></EmptyCard>
        </div>
      ) : (
        <div className="space-y-8">
          <section aria-label="Support health" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Open tickets" value={m.open} sub={`${m.needsHuman} need a person · ${m.unassigned} unassigned`} />
            <Metric label="Urgent" value={m.urgent} sub="Safety and high-impact issues" />
            <Metric label="First response overdue" value={m.overdueFirstResponse} sub="Against internal SLA targets" />
            <Metric label="Refunds awaiting" value={m.refunds.requested + m.refunds.approved} sub={m.refunds.issuedCents ? `${fmt(m.refunds.issuedCents)} issued` : undefined} />
          </section>

          <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <section aria-label="Latest tickets" className="rounded-2xl border border-mist bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-mist px-6 py-4">
                <h2 className="font-display text-lg font-bold">Latest activity</h2>
                <Link href="/admin/support" className="text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Open inbox →</Link>
              </div>
              {recent.length === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No tickets yet. New requests from support.zapnivo.com appear here instantly.</p>
              ) : (
                <ul className="divide-y divide-mist/80">
                  {recent.map((t) => (
                    <li key={t.id}>
                      <Link href={`/admin/support/${t.number}`} className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-mist/30">
                        <span className="w-20 shrink-0 font-bold">{t.number}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{t.subject}</span>
                          <span className="block truncate text-xs text-graphite">{t.name} · {t.requesterType}</span>
                        </span>
                        <span className="hidden sm:block"><Pill tone={t.queue === "safety" ? "red" : t.queue === "billing" ? "gold" : t.queue === "partner" ? "cyan" : "mist"}>{t.queue}</Pill></span>
                        <span className="hidden text-xs text-graphite md:block">{t.firstResponseAt ? humanDue(t.resolutionDueAt, now) : humanDue(t.firstResponseDueAt, now)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="space-y-6">
              <section aria-label="Operations" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Operations</h2>
                <ul className="mt-4 space-y-3 text-sm">
                  <li className="flex items-start gap-3"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-silver" aria-hidden /><span><b>Stations</b> — none provisioned yet. First kiosk appears once registered.</span></li>
                  <li className="flex items-start gap-3"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-silver" aria-hidden /><span><b>Rentals</b> — go live with the first station.</span></li>
                  <li className="flex items-start gap-3"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-silver" aria-hidden /><span><b>Revenue</b> — reporting activates with payment integration.</span></li>
                </ul>
              </section>
              <section aria-label="Response" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Response</h2>
                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex items-baseline justify-between"><dt className="text-graphite">Avg first response</dt><dd className="font-display text-xl font-bold">{m.avgFirstResponseHours == null ? "—" : `${m.avgFirstResponseHours}h`}</dd></div>
                  <div className="flex items-baseline justify-between"><dt className="text-graphite">Resolved</dt><dd className="font-display text-xl font-bold">{m.resolved}</dd></div>
                  <div className="flex items-baseline justify-between"><dt className="text-graphite">Resolved by AI alone</dt><dd className="font-display text-xl font-bold">{m.aiResolved}{m.aiDeflectionRate != null && <span className="ml-1 text-xs font-semibold text-graphite">({m.aiDeflectionRate}%)</span>}</dd></div>
                </dl>
                <Link href="/admin/support/metrics" className="mt-4 inline-block text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">All metrics →</Link>
              </section>
            </div>
          </div>
        </div>
      )}
    </AdminGate>
  );
}
