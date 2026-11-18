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
import { loadCustomer360 } from "@/lib/crm";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";

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
  // Customer 360 side-panel: rentals, account status and history for the requester's email.
  const db = serviceClient();
  const customer = db && data ? await loadCustomer360(db, data.ticket.email) : null;

  return (
    <AdminGate title={data ? `${data.ticket.number} · ${data.ticket.category}` : "Ticket"} nav={data?.ticket.queue === "partner" ? "partner" : data?.ticket.queue === "safety" ? "safety" : "inbox"}>
      {!data || !user ? <EmptyCard title="Support system not connected">Connect Supabase or enable the dev store.</EmptyCard> : (() => {
        const t = data.ticket;
        const sla = slaStatus(t, now);
        return (
          <div className="space-y-5">
            <TicketLive ticketId={t.id} intervalMs={15000} accessToken={accessToken} />
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <Link href="/admin/support" className="font-bold text-graphite hover:text-ink">← All conversations</Link>
              <div className="flex flex-wrap gap-2"><a href="#ticket-conversation" className="rounded-lg border border-mist bg-white px-3 py-2 font-bold hover:bg-lime/30">Conversation</a><a href="#ticket-controls" className="rounded-lg border border-mist bg-white px-3 py-2 font-bold hover:bg-lime/30">Case controls</a><a href="#ticket-compose" className="rounded-lg bg-ink px-3 py-2 font-bold text-white hover:bg-forest">Write a reply ↓</a></div>
            </div>
            <section aria-label="Case overview" className="rounded-2xl border border-[#dbe5dc] bg-white p-5 shadow-sm md:p-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div><p className="eyebrow text-forest">Support case / {t.number}</p><h2 className="mt-2 text-2xl font-bold tracking-tight md:text-3xl">{t.subject || t.category}</h2><p className="mt-2 text-sm text-graphite">From {t.name} · opened {when(t.createdAt)} · {t.queue} queue</p></div>
                <div className="flex flex-wrap gap-2"><Pill tone={t.state === "resolved" || t.state === "closed" ? "lime" : "gold"}>{t.state.replace(/_/g, " ")}</Pill><Pill tone={t.priority === "urgent" ? "red" : t.priority === "high" ? "gold" : "mist"}>{t.priority} priority</Pill></div>
              </div>
              <div className="mt-5 grid gap-3 border-t border-mist pt-4 text-xs sm:grid-cols-3">
                <div><p className="font-bold uppercase tracking-wider text-graphite">Owner</p><p className="mt-1 font-semibold">{t.assignedTo ? "Assigned" : "Unassigned"}</p></div>
                <div><p className="font-bold uppercase tracking-wider text-graphite">First response</p><p className="mt-1 font-semibold">{t.firstResponseAt ? "Met" : humanDue(t.firstResponseDueAt, now)}</p></div>
                <div><p className="font-bold uppercase tracking-wider text-graphite">Resolution target</p><p className="mt-1 font-semibold">{t.resolvedAt ? "Resolved" : humanDue(t.resolutionDueAt, now)}</p></div>
              </div>
            </section>
            <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 space-y-5">
              {t.queue === "safety" && <p role="alert" className="rounded-xl bg-red-100 p-4 text-sm font-bold text-red-900">SAFETY REPORT. Possible battery hazard. Contact the requester, arrange retrieval of the unit, and log the incident in Fleet. Do not close until the unit is secured.</p>}
              {t.aiSummary && <div className="rounded-xl border border-lime bg-[#f0f7e3] p-4 text-sm"><p className="text-xs font-extrabold uppercase tracking-wider text-forest">Agent brief · AI generated</p><p className="mt-2 leading-6">{t.aiSummary}</p></div>}
              <section id="ticket-conversation" className="scroll-mt-40 overflow-hidden rounded-2xl border border-mist bg-white">
                <div className="flex items-center justify-between border-b border-mist px-5 py-4"><div><p className="eyebrow text-forest">Conversation</p><h3 className="mt-1 text-lg font-bold">{data.messages.length} message{data.messages.length === 1 ? "" : "s"}</h3></div><span className="text-xs text-graphite">Oldest first</span></div>
              <ol className="space-y-0 divide-y divide-mist/70 px-5" aria-label="Conversation">
                {data.messages.map((m) => (
                  <li key={m.id} className={m.internal ? "my-3 rounded-xl border border-gold/60 bg-gold/15 p-4" : "py-5"}>
                    <p className="flex flex-wrap items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-forest/70">
                      {m.internal && <Pill tone="gold">Internal</Pill>}<span>{m.authorName || m.authorType}</span><Pill tone={m.authorType === "ai" ? "lime" : m.authorType === "system" ? "mist" : "ink"}>{m.authorType}</Pill><span className="font-medium normal-case tracking-normal">{when(m.createdAt)}</span>
                    </p>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{m.body}</p>
                  </li>
                ))}
              </ol>
              </section>
              <div id="ticket-compose" className="scroll-mt-40">
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
            </div>

            <aside className="min-w-0 space-y-4 self-start text-sm xl:sticky xl:top-24" aria-label="Ticket details">
              <div className="rounded-xl bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-lg font-bold">Requester</h2>
                  {customer && <Link href={`/admin/customers/${encodeURIComponent(customer.email)}`} className="text-xs font-bold underline underline-offset-2">360° →</Link>}
                </div>
                <p className="mt-2 font-semibold">{t.name}</p><p className="text-graphite">{t.email}{t.phone ? ` · ${t.phone}` : ""}</p>
                <p className="mt-1 text-xs text-graphite">{t.requesterType === "partner" ? `Partner${t.venueLabel ? ` · ${t.venueLabel}` : ""}` : "Customer"}{t.stationLabel ? ` · ${t.stationLabel}` : ""}</p>
                <div className="mt-3 flex flex-wrap gap-1.5"><Pill tone="mist">{t.queue}</Pill><Pill tone={t.priority === "urgent" ? "red" : t.priority === "high" ? "gold" : "mist"}>{t.priority}</Pill><Pill tone={t.aiState === "ai_active" ? "lime" : t.aiState === "needs_human" ? "gold" : "ink"}>{t.aiState.replace("_", " ")}</Pill></div>
                {customer && (
                  <dl className="mt-3 space-y-1 border-t border-mist pt-3 text-xs text-graphite">
                    <div className="flex justify-between"><dt>Record</dt><dd className="font-bold text-ink">{customer.profile ? `account · ${customer.profile.role}` : "guest"}</dd></div>
                    <div className="flex justify-between"><dt>Lifetime captured</dt><dd className="font-bold text-ink">{fmt(customer.totals.capturedCents)}{customer.totals.refundedCents > 0 ? ` (${fmt(customer.totals.refundedCents)} refunded)` : ""}</dd></div>
                    <div className="flex justify-between"><dt>Rentals</dt><dd className="font-bold text-ink">{customer.rentals.length}{customer.totals.activeRentals ? ` · ${customer.totals.activeRentals} out` : ""}</dd></div>
                    <div className="flex justify-between"><dt>Tickets</dt><dd className="font-bold text-ink">{customer.tickets.length}{customer.totals.openTickets ? ` · ${customer.totals.openTickets} open` : ""}</dd></div>
                    {customer.notes.length > 0 && <div className="flex justify-between"><dt>Staff notes</dt><dd className="font-bold text-ink">{customer.notes.length}</dd></div>}
                  </dl>
                )}
              </div>
              {customer && customer.rentals.length > 0 && (
                <div className="rounded-xl bg-white p-4 shadow-sm">
                  <h2 className="font-display text-lg font-bold">Their rentals ({customer.rentals.length})</h2>
                  <ul className="mt-3 space-y-2">
                    {customer.rentals.slice(0, 6).map((r) => {
                      const isThisTicket = !!t.rentalRef && r.reference === t.rentalRef;
                      const od = !!r.non_return_deadline && !r.returned_at && new Date(r.non_return_deadline) < new Date();
                      return (
                        <li key={r.id} className={`rounded-lg p-2.5 text-xs ${isThisTicket ? "border-2 border-lime bg-lime/10" : "bg-mist/50"}`}>
                          <p className="flex items-center justify-between gap-2">
                            <b>{r.reference}{isThisTicket && <span className="ml-1 font-bold text-forest">· this ticket</span>}</b>
                            <Pill tone={od ? "red" : r.state === "active" ? "lime" : r.state === "unreturned" ? "red" : r.state === "returned" ? "mist" : "cyan"}>{od ? "overdue" : r.state.replace("_", " ")}</Pill>
                          </p>
                          <p className="mt-1 text-graphite">{r.kiosks?.venues?.name ?? r.kiosks?.station_id ?? "—"} · {when(r.dispensed_at ?? r.started_at ?? r.created_at)}</p>
                        </li>
                      );
                    })}
                  </ul>
                  {customer.rentals.length > 6 && <p className="mt-2 text-xs"><Link href={`/admin/customers/${encodeURIComponent(customer.email)}`} className="font-bold underline">All {customer.rentals.length} rentals →</Link></p>}
                </div>
              )}
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
          </div>
        );
      })()}
    </AdminGate>
  );
}
