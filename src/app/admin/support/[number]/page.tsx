export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { AgentConsole } from "@/components/AgentConsole";
import { AdminGate } from "@/components/AdminShell";
import { TicketLive } from "@/components/TicketLive";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { SESSION_COOKIE, getSessionUser } from "@/lib/auth";
import { assistantConfigured } from "@/lib/ai/openrouter";
import { MACROS, renderMacro } from "@/lib/helpdesk/macros";
import { snapshot, suggestRefund, type Suggestion } from "@/lib/helpdesk/refund-policy";
import { defaultCtx, getStaffThread } from "@/lib/helpdesk/service";
import { humanDue, slaStatus } from "@/lib/helpdesk/sla";
import { HelpdeskError, REFUND_REASONS, type RefundReason } from "@/lib/helpdesk/types";
import { fmt } from "@/lib/pricing";

export const metadata: Metadata = { title: "Ticket", robots: { index: false, follow: false } };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export default async function TicketPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const user = await getSessionUser();
  const ctx = await defaultCtx();
  const staff = user && (user.role === "admin" || user.role === "staff") ? ({ kind: "staff", id: user.id, name: user.email.split("@")[0], role: user.role } as const) : null;

  let data: Awaited<ReturnType<typeof getStaffThread>> | null = null;
  if (ctx && staff) { try { data = await getStaffThread(ctx, staff, number); } catch (e) { if (e instanceof HelpdeskError && e.code === "not_found") notFound(); throw e; } }

  let suggestions: Record<RefundReason, Suggestion> | null = null;
  if (data?.ticket.rentalRef && ctx) {
    const row = await ctx.rentals.byReference(data.ticket.rentalRef);
    if (row) { const snap = snapshot(row); suggestions = Object.fromEntries(REFUND_REASONS.map((r) => [r, suggestRefund(snap, r)])) as Record<RefundReason, Suggestion>; }
  }
  const now = new Date();
  const accessToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;

  return (
    <AdminGate title={data ? `${data.ticket.number} · ${data.ticket.category}` : "Ticket"} nav={data?.ticket.queue === "partner" ? "partner" : data?.ticket.queue === "safety" ? "safety" : "inbox"}>
      {!data || !user ? <EmptyCard title="Support system not connected">Connect Supabase or enable the dev store.</EmptyCard> : (() => {
        const t = data.ticket;
        const sla = slaStatus(t, now);
        return (
          <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <TicketLive ticketId={t.id} intervalMs={15000} accessToken={accessToken} />
            <div className="space-y-6">
              <Link href="/admin/support" className="text-sm font-bold underline underline-offset-4">← Inbox</Link>
              {t.queue === "safety" && <p role="alert" className="rounded-xl bg-red-100 p-4 text-sm font-bold text-red-900">SAFETY REPORT. Possible battery hazard. Contact the requester, arrange retrieval of the unit, and log the incident in Fleet. Do not close until the unit is secured.</p>}
              {t.aiSummary && <div className="rounded-xl border border-lime bg-lime/20 p-4 text-sm"><b>AI summary:</b> {t.aiSummary}</div>}
              <ol className="space-y-3" aria-label="Conversation">
                {data.messages.map((m) => (
                  <li key={m.id} className={m.internal ? "rounded-xl border border-gold bg-gold/20 p-4" : m.authorType === "customer" || m.authorType === "partner" ? "rounded-xl bg-white p-4 shadow-sm" : "ml-6 rounded-xl border-l-4 border-lime bg-white p-4 shadow-sm"}>
                    <p className="flex flex-wrap items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-forest/70">
                      {m.internal && <Pill tone="gold">Internal</Pill>}<span>{m.authorName || m.authorType}</span><Pill tone={m.authorType === "ai" ? "lime" : m.authorType === "system" ? "mist" : "ink"}>{m.authorType}</Pill><span className="font-medium normal-case tracking-normal">{when(m.createdAt)}</span>
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{m.body}</p>
                  </li>
                ))}
              </ol>
              <AgentConsole
                ticket={{ number: t.number, state: t.state, priority: t.priority, assignedTo: t.assignedTo, rentalRef: t.rentalRef }}
                me={{ id: user.id, role: user.role === "admin" ? "admin" : "staff" }}
                aiAvailable={assistantConfigured()}
                macros={MACROS.filter((m) => m.audience === "both" || m.audience === t.requesterType).map((m) => ({ id: m.id, title: m.title, text: renderMacro(m, { name: t.name.split(" ")[0], ticket: t.number, agent: user.email.split("@")[0] }) }))}
                suggestions={suggestions}
                remainingCents={data.remainingCents}
                refunds={data.refunds}
              />
            </div>

            <aside className="space-y-4 text-sm" aria-label="Ticket details">
              <div className="rounded-xl bg-white p-4 shadow-sm">
                <h2 className="font-display text-lg font-bold">Requester</h2>
                <p className="mt-2 font-semibold">{t.name}</p><p className="text-graphite">{t.email}{t.phone ? ` · ${t.phone}` : ""}</p>
                <p className="mt-1 text-xs text-graphite">{t.requesterType === "partner" ? `Partner${t.venueLabel ? ` · ${t.venueLabel}` : ""}` : "Customer"}{t.stationLabel ? ` · ${t.stationLabel}` : ""}</p>
                <div className="mt-3 flex flex-wrap gap-1.5"><Pill tone="mist">{t.queue}</Pill><Pill tone={t.priority === "urgent" ? "red" : t.priority === "high" ? "gold" : "mist"}>{t.priority}</Pill><Pill tone={t.aiState === "ai_active" ? "lime" : t.aiState === "needs_human" ? "gold" : "ink"}>{t.aiState.replace("_", " ")}</Pill></div>
              </div>
              <div className="rounded-xl bg-white p-4 shadow-sm">
                <h2 className="font-display text-lg font-bold">SLA (internal)</h2>
                <p className="mt-2">First response: <Pill tone={sla.firstResponse === "breached" ? "red" : sla.firstResponse === "due_soon" ? "gold" : sla.firstResponse === "met" ? "lime" : "mist"}>{t.firstResponseAt ? "met" : humanDue(t.firstResponseDueAt, now)}</Pill></p>
                <p className="mt-1">Resolution: <Pill tone={sla.resolution === "breached" ? "red" : sla.resolution === "met" ? "lime" : "mist"}>{t.resolvedAt ? "resolved" : humanDue(t.resolutionDueAt, now)}</Pill></p>
              </div>
              {data.rental && (
                <div className="rounded-xl bg-white p-4 shadow-sm">
                  <h2 className="font-display text-lg font-bold">Rental {data.rental.reference}</h2>
                  <p className="mt-2"><Pill tone={data.rental.tone === "warn" ? "gold" : data.rental.tone === "ok" ? "lime" : "cyan"}>{data.rental.status}</Pill></p>
                  <dl className="mt-3 space-y-1 text-graphite"><div>Station: {data.rental.station}</div><div>Charge: {data.rental.charge}</div>{data.rental.expectedCents != null && <div>Published rate for period: {fmt(data.rental.expectedCents)}</div>}<div>Refundable balance: {fmt(data.remainingCents ?? 0)}</div></dl>
                  <p className="mt-3 rounded-lg bg-mist/70 p-2 text-xs leading-5 text-graphite">{data.rental.explanation}</p>
                </div>
              )}
              <div className="rounded-xl bg-white p-4 shadow-sm">
                <h2 className="font-display text-lg font-bold">Timeline</h2>
                <ol className="mt-3 space-y-2 text-xs text-graphite">{data.events.map((e) => <li key={e.id}><b className="text-ink">{e.type.replace(/_/g, " ")}</b> · {e.actor} · {when(e.createdAt)}</li>)}</ol>
              </div>
            </aside>
          </div>
        );
      })()}
    </AdminGate>
  );
}
