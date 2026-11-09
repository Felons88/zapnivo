export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/AdminCards";
import { assistantConfigured } from "@/lib/ai/openrouter";
import { mailerConfigured } from "@/lib/helpdesk/mailer";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { SLA_HOURS } from "@/lib/helpdesk/sla";
import { fmt, } from "@/lib/pricing";
import { stripeLinked } from "@/lib/payments/source";

export const metadata: Metadata = { title: "Support metrics", robots: { index: false, follow: false } };

export default async function MetricsPage() {
  const ctx = await defaultCtx();
  const m = ctx ? await computeMetrics(ctx.repo) : null;
  const queued = ctx ? (await ctx.repo.listEmails("queued")).length : 0;
  const failed = ctx ? (await ctx.repo.listEmails("failed")).length : 0;
  const dash = (v: number | null, suffix = "") => (v == null ? "—" : `${v}${suffix}`);

  return (
    <AdminGate title="Support metrics" nav="metrics">
      {!m ? <EmptyCard title="Support system not connected">Connect Supabase or enable the dev store.</EmptyCard> : (
        <div className="space-y-8">
          <section aria-label="Queue health" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Open tickets" value={m.open} sub={`${m.needsHuman} need a person · ${m.unassigned} unassigned`} />
            <Metric label="Urgent" value={m.urgent} sub="Safety and high-impact issues" />
            <Metric label="First response overdue" value={m.overdueFirstResponse} sub="Against internal targets" />
            <Metric label="Resolution overdue" value={m.overdueResolution} sub="Against internal targets" />
            <Metric label="Avg first response" value={dash(m.avgFirstResponseHours, "h")} sub="Human replies only" />
            <Metric label="Resolved" value={m.resolved} />
            <Metric label="Resolved by AI alone" value={m.aiResolved} sub={m.aiDeflectionRate == null ? "No resolved tickets yet" : `${m.aiDeflectionRate}% of resolved`} />
            <Metric label="By queue" value={`${m.byQueue.customer}/${m.byQueue.billing}/${m.byQueue.partner}/${m.byQueue.safety}`} sub="customer / billing / partner / safety" />
          </section>
          <section aria-label="Refunds" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Refunds awaiting decision" value={m.refunds.requested} />
            <Metric label="Approved, not issued" value={m.refunds.approved} />
            <Metric label="Issued" value={m.refunds.issued} sub={fmt(m.refunds.issuedCents)} />
            <Metric label="Denied / failed" value={`${m.refunds.denied} / ${m.refunds.failed}`} />
          </section>
          <section aria-label="System status" className="rounded-xl bg-white/5 p-6 shadow-sm">
            <h2 className="font-display text-xl font-bold">System status</h2>
            <ul className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              {[
                ["AI assistant (OpenRouter)", assistantConfigured(), "Set OPENROUTER_API_KEY"],
                ["Email delivery (Resend)", mailerConfigured(), `Set RESEND_API_KEY + SUPPORT_FROM_EMAIL. ${queued} email(s) waiting, ${failed} failed`],
                ["Stripe (refunds & live payment data)", stripeLinked(), "Not linked. Refunds are approved here and issued manually"],
              ].map(([k, ok, hint]) => <li key={String(k)} className="flex items-start gap-3 rounded-lg bg-white/10 p-3"><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${ok ? "bg-green-500" : "bg-gold"}`} aria-hidden /><span><b>{String(k)}</b><br /><span className="text-silver">{ok ? "Connected" : String(hint)}</span></span></li>)}
            </ul>
            <h3 className="mt-6 font-bold">Internal SLA targets (hours)</h3>
            <p className="mt-1 text-xs text-silver">{Object.entries(SLA_HOURS).map(([p, s]) => `${p}: first reply ${s.first}h · resolve ${s.resolve}h`).join("  |  ")}</p>
          </section>
        </div>
      )}
    </AdminGate>
  );
}
