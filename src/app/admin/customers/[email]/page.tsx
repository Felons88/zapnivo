export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { fmt } from "@/lib/pricing";
import { loadCustomer360, OPEN_RENTAL_STATES, type CrmRental } from "@/lib/crm";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import { TICKET_CATEGORIES } from "@/lib/validation";
import { REFUND_REASONS } from "@/lib/helpdesk/types";

export const metadata: Metadata = { title: "Customer 360", robots: { index: false, follow: false } };

const STATE_TONE = { active: "lime", return_pending: "lime", dispense_pending: "cyan", authorized: "cyan", payment_authorized: "cyan", pending_payment: "mist", overdue: "red", unreturned: "red", non_return_fee_pending: "red", disputed: "gold", returned: "mist", cancelled: "mist", charged_off: "gold" } as const;
const TICKET_TONE = { open: "gold", pending_customer: "cyan", pending_internal: "cyan", resolved: "lime", closed: "mist" } as const;
const REFUND_TONE = { requested: "gold", approved: "cyan", denied: "red", issued: "lime", failed: "red" } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const input = "min-h-10 rounded-lg border border-silver/70 px-3 text-sm";
const btn = "min-h-8 rounded-full px-3 text-xs font-bold";

const overdue = (r: CrmRental) => !!r.non_return_deadline && !r.returned_at && new Date(r.non_return_deadline) < new Date();
const isOpen = (r: CrmRental) => OPEN_RENTAL_STATES.includes(r.state as (typeof OPEN_RENTAL_STATES)[number]);
/** States where the bank is still out — returnable + pausable. */
const isOut = (r: CrmRental) => ["active", "return_pending", "overdue", "unreturned"].includes(r.state);
const paySummary = (r: CrmRental) => {
  const p = r.payments?.[0];
  if (!p) return "—";
  const amt = p.amount_captured_cents ?? p.amount_authorized_cents ?? 0;
  const refunded = p.amount_refunded_cents ?? 0;
  return `${fmt(amt)} · ${p.state}${refunded > 0 ? ` · ${fmt(refunded)} refunded` : ""}`;
};

export default async function Customer360({ params, searchParams }: { params: Promise<{ email: string }>; searchParams: Promise<{ result?: string; detail?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user)) redirect("/partners");
  const { email: raw } = await params;
  const feedback = await searchParams;
  const email = decodeURIComponent(raw).toLowerCase();
  const back = `/admin/customers/${encodeURIComponent(email)}`;
  const isAdmin = user.role === "admin";
  const db = serviceClient();
  const c = db ? await loadCustomer360(db, email) : null;
  const activity = c ? [
    ...c.tickets.map((t) => ({ id: `ticket-${t.id}`, at: t.created_at, title: `Ticket ${t.ticket_number} opened`, detail: `${t.category} · ${t.state.replace(/_/g, " ")}`, href: `/admin/support/${t.ticket_number}` })),
    ...c.rentals.map((r) => ({ id: `rental-${r.id}`, at: r.created_at, title: `Rental ${r.reference}`, detail: `${r.state.replace(/_/g, " ")} · ${r.kiosks?.venues?.name ?? r.kiosks?.station_id ?? "Station unknown"}`, href: "#customer-rentals" })),
    ...c.notes.map((n) => ({ id: `note-${n.id}`, at: n.created_at, title: "Staff note added", detail: n.author_email ?? "Staff", href: "#customer-actions" })),
    ...c.refundRequests.map((r) => ({ id: `refund-${r.id}`, at: r.created_at, title: `Refund request for ${r.rental_ref}`, detail: `${fmt(r.amount_cents)} · ${r.status}`, href: "#customer-support" })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12) : [];

  return (
    <AdminGate title={c?.names[0] ?? email} nav="customers">
      {!db ? (
        <EmptyCard title="Customer data not connected">Connect Supabase to see customer records.</EmptyCard>
      ) : !c ? (
        <EmptyCard title="Not a valid customer">“{email}” isn't a recognizable customer email. <Link href="/admin/customers" className="underline">Search again</Link>.</EmptyCard>
      ) : (
        <div className="space-y-6">
          {feedback.result && (
            <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" || feedback.result === "flagged" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>
              {feedback.detail ?? "Done."}
            </div>
          )}

          <p><Link href="/admin/customers" className="text-sm font-bold text-graphite hover:text-ink">← New search</Link></p>
          <nav aria-label="Customer record sections" className="flex gap-2 overflow-x-auto pb-1">
            {[["Overview", "customer-overview"], ["Activity", "customer-activity"], ["Actions", "customer-actions"], ["Rentals", "customer-rentals"], ["Support", "customer-support"], ["Communications", "customer-comms"]].map(([label, target]) =>
              <a key={target} href={`#${target}`} className="shrink-0 rounded-lg border border-mist bg-white px-4 py-2 text-xs font-bold text-forest hover:bg-lime/20">{label}</a>)}
          </nav>

          {/* ── Identity ─────────────────────────────────────────── */}
          <section id="customer-overview" className="scroll-mt-40 rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="eyebrow text-forest">Customer 360</p>
                <h2 className="mt-1 font-display text-2xl font-bold">{c.names[0] ?? c.email}</h2>
                <p className="mt-1 text-sm font-semibold">{c.email}</p>
                {c.phones.length > 0 && <p className="mt-0.5 text-sm text-graphite">{c.phones.join(" · ")}</p>}
                {c.names.length > 1 && <p className="mt-0.5 text-xs text-graphite">Also seen as: {c.names.slice(1).join(", ")}</p>}
              </div>
              <div className="text-right text-xs text-graphite">
                {c.profile ? (
                  <>
                    <Pill tone="lime">account · {c.profile.role}</Pill>
                    <p className="mt-2">Joined {new Date(c.profile.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
                    <p className="mt-1">{c.profile.notify_sms ? "SMS notifications on" : "SMS notifications off"}</p>
                  </>
                ) : (
                  <><Pill tone="mist">guest — no account</Pill><p className="mt-2 max-w-[220px]">No login on file; history comes from receipts, tickets and payment records.</p></>
                )}
              </div>
            </div>
          </section>

          <section aria-label="Customer summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Rentals" value={c.rentals.length} sub={`${c.totals.activeRentals} active or out`} />
            <Metric label="Lifetime captured" value={fmt(c.totals.capturedCents)} sub={c.totals.refundedCents > 0 ? `${fmt(c.totals.refundedCents)} refunded` : undefined} />
            <Metric label="Support tickets" value={c.tickets.length} sub={`${c.totals.openTickets} open`} />
            <Metric label="Staff notes" value={c.notes.length} sub={c.incidents.length ? `${c.incidents.length} incident report${c.incidents.length === 1 ? "" : "s"}` : undefined} />
          </section>

          <section id="customer-activity" aria-label="Customer activity" className="scroll-mt-40 rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-2"><div><p className="eyebrow text-silver">Record history</p><h2 className="mt-1 font-display text-lg font-bold">Recent activity</h2></div><span className="text-xs text-graphite">Rentals, support and staff notes</span></div>
            {activity.length === 0 ? <p className="mt-4 text-sm text-graphite">No activity on this record yet.</p> : <ol className="mt-4 divide-y divide-mist">
              {activity.map((item) => <li key={item.id}><Link href={item.href} className="flex gap-4 py-3 hover:text-forest"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-forest" aria-hidden /><span className="min-w-0 flex-1"><span className="block text-sm font-bold">{item.title}</span><span className="block truncate text-xs text-graphite">{item.detail}</span></span><span className="shrink-0 text-xs text-graphite">{when(item.at)}</span></Link></li>)}
            </ol>}
          </section>

          {/* ── Actions ──────────────────────────────────────────── */}
          <div id="customer-actions" className="scroll-mt-40 grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
            <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Open a ticket for this customer</h2>
              <p className="mt-1 text-xs text-graphite">For phone/walk-up contacts. The customer gets the usual confirmation email and can reply to the thread.</p>
              <form method="post" action="/api/admin/customers" className="mt-4 space-y-3">
                <input type="hidden" name="action" value="create_ticket" />
                <input type="hidden" name="email" value={c.email} />
                <input type="hidden" name="phone" value={c.phones[0] ?? ""} />
                <div>
                  <label htmlFor="ct-name" className="mb-1 block text-xs font-bold">Customer name</label>
                  <input id="ct-name" name="name" defaultValue={c.names[0] ?? ""} required className={`${input} w-full`} />
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label htmlFor="ct-cat" className="mb-1 block text-xs font-bold">Category</label>
                    <select id="ct-cat" name="category" className={`${input} w-full`}>{TICKET_CATEGORIES.map((x) => <option key={x}>{x}</option>)}</select>
                  </div>
                  <div>
                    <label htmlFor="ct-ref" className="mb-1 block text-xs font-bold">Rental ref (optional)</label>
                    <select id="ct-ref" name="rentalRef" className={input}><option value="">—</option>{c.rentals.map((r) => <option key={r.id}>{r.reference}</option>)}</select>
                  </div>
                </div>
                <div>
                  <label htmlFor="ct-desc" className="mb-1 block text-xs font-bold">What they need</label>
                  <textarea id="ct-desc" name="description" required minLength={10} maxLength={4000} rows={3} className="w-full rounded-lg border border-silver/70 px-3 py-2 text-sm" placeholder="Customer called about…" />
                </div>
                <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Create ticket</button>
              </form>
            </section>

            <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Grant credit</h2>
              <p className="mt-1 text-xs text-graphite">Entitlement credit on the customer&apos;s account — auto-applies on their next rental. The customer is emailed.</p>
              {c.profile ? (
                <form method="post" action="/api/admin/customers" className="mt-4 space-y-3">
                  <input type="hidden" name="action" value="grant_credit" />
                  <input type="hidden" name="email" value={c.email} />
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label htmlFor="gc-amount" className="mb-1 block text-xs font-bold">Amount</label>
                      <input id="gc-amount" name="amount" type="number" min="1" required className={`${input} w-full`} placeholder="500" />
                    </div>
                    <div>
                      <label htmlFor="gc-unit" className="mb-1 block text-xs font-bold">Unit</label>
                      <select id="gc-unit" name="unit" className={input}><option value="cent">cents</option><option value="minute">minutes</option><option value="rental">rental</option></select>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="gc-note" className="mb-1 block text-xs font-bold">Reason (shown to customer)</label>
                    <input id="gc-note" name="note" maxLength={200} className={`${input} w-full`} placeholder="e.g. Goodwill for the failed dispense" />
                  </div>
                  <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Grant credit</button>
                </form>
              ) : (
                <p className="mt-4 text-sm text-graphite">Guest record — no account profile to attach credit to. Ask the customer to create an account, or issue a refund instead.</p>
              )}
            </section>

            <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Add a staff note</h2>
              <p className="mt-1 text-xs text-graphite">Internal only — attached to this customer and audit-logged. Never emailed.</p>
              <form method="post" action="/api/admin/customers" className="mt-4 space-y-3">
                <input type="hidden" name="action" value="add_note" />
                <input type="hidden" name="email" value={c.email} />
                <textarea name="body" required minLength={2} maxLength={4000} rows={4} className="w-full rounded-lg border border-silver/70 px-3 py-2 text-sm" placeholder="e.g. Customer says kiosk at Demo Tavern ate the bank — verify against slot telemetry before refund…" />
                <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Save note</button>
              </form>

              {c.notes.length > 0 && (
                <ul className="mt-5 space-y-3 border-t border-mist pt-4">
                  {c.notes.map((n) => (
                    <li key={n.id} className="rounded-xl bg-mist/50 px-4 py-3 text-sm">
                      <p className="whitespace-pre-wrap">{n.body}</p>
                      <p className="mt-1 text-xs text-graphite">{n.author_email ?? "Staff"} · {when(n.created_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* ── Rentals ──────────────────────────────────────────── */}
          <section id="customer-rentals" aria-label="Rentals" className="scroll-mt-40 overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Rentals ({c.rentals.length})</h2></div>
            {c.rentals.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No rentals on record for this customer.</p>
            ) : (
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Reference", "Station", "State", "Started", "Returned", "Due back", "Payment", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {c.rentals.map((r) => {
                    const od = overdue(r);
                    const incidents = c.incidents.filter((i) => i.rental_id === r.id);
                    return (
                      <tr key={r.id} className="border-b border-mist/70 align-top last:border-0 hover:bg-lime/10">
                        <td className="px-4 py-3">
                          <p className="font-bold">{r.reference}</p>
                          {incidents.map((i) => <p key={i.id} className="mt-1 text-xs font-bold text-red-800">⚑ {i.kind} reported</p>)}
                        </td>
                        <td className="px-4 py-3"><p className="font-semibold">{r.kiosks?.venues?.name ?? r.kiosks?.station_id ?? "—"}</p><p className="text-xs text-graphite">{r.kiosks?.venues?.city ?? ""}</p></td>
                        <td className="px-4 py-3">
                          <Pill tone={r.paused_at ? "gold" : od ? "red" : STATE_TONE[r.state as keyof typeof STATE_TONE] ?? "mist"}>{r.paused_at ? "paused" : od ? "overdue" : r.state.replace("_", " ")}</Pill>
                          {r.paused_at && <p className="mt-1 text-[10px] font-bold text-graphite">clock stopped · {Math.round(((r.paused_seconds ?? 0) + (Date.now() - new Date(r.paused_at).getTime()) / 1000) / 60)} min paused</p>}
                        </td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(r.started_at ?? r.created_at)}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(r.returned_at)}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(r.non_return_deadline)}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{paySummary(r)}</td>
                        <td className="px-4 py-3">
                          <div className="space-y-2">
                            {(r.state === "authorized" || r.state === "dispense_pending") && (
                              <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="dispense" /><input type="hidden" name="back" value={back} /><button className={`${btn} bg-lime text-ink`}>Confirm dispense</button></form>
                            )}
                            {isOut(r) && (
                              <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="return" /><input type="hidden" name="back" value={back} /><button className={`${btn} border border-silver/60 hover:border-ink`}>Record return</button></form>
                            )}
                            {isOut(r) && (
                              r.paused_at ? (
                                <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="resume" /><input type="hidden" name="back" value={back} /><button className={`${btn} bg-gold/70 text-ink`}>Resume clock</button></form>
                              ) : (
                                <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="pause" /><input type="hidden" name="back" value={back} /><button className={`${btn} border border-gold/70 hover:border-ink`}>Pause clock</button></form>
                              )
                            )}
                            {isOpen(r) && (
                              <form method="post" action={`/api/rentals/${r.id}`} className="flex items-center gap-1">
                                <input type="hidden" name="action" value="extend" /><input type="hidden" name="back" value={back} />
                                <select name="hours" defaultValue="24" aria-label="Extra hours" className="min-h-8 rounded-lg border border-silver/60 px-1.5 text-xs font-semibold">
                                  {[4, 12, 24, 48, 72].map((h) => <option key={h} value={h}>+{h}h</option>)}
                                </select>
                                <button className={`${btn} border border-silver/60 hover:border-ink`}>Extend</button>
                              </form>
                            )}
                            {r.payments?.length > 0 && (r.payments[0].amount_captured_cents ?? 0) > 0 && (
                              <form method="post" action="/api/admin/customers" className="flex items-center gap-1">
                                <input type="hidden" name="action" value="request_refund" /><input type="hidden" name="email" value={c.email} />
                                <input type="hidden" name="name" value={c.names[0] ?? ""} /><input type="hidden" name="rentalRef" value={r.reference} />
                                <input name="amountCents" type="number" min="1" max={(r.payments[0].amount_captured_cents ?? 0) - (r.payments[0].amount_refunded_cents ?? 0)} required placeholder="¢" aria-label="Refund amount in cents" className="min-h-8 w-20 rounded-lg border border-silver/60 px-1.5 text-xs" />
                                <select name="reason" defaultValue="goodwill" aria-label="Refund reason" className="min-h-8 rounded-lg border border-silver/60 px-1.5 text-xs font-semibold">
                                  {REFUND_REASONS.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ")}</option>)}
                                </select>
                                <button className={`${btn} bg-mist hover:bg-lime`}>Refund</button>
                              </form>
                            )}
                            {isAdmin && (od || r.state === "unreturned") && r.payments?.[0]?.state === "authorized" && (
                              <form method="post" action={`/api/rentals/${r.id}`} className="space-y-1 rounded-lg border border-red-200 p-2">
                                <input type="hidden" name="action" value="nonreturn" /><input type="hidden" name="back" value={back} />
                                <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="confirm" value="yes" required /> Not returned — charge the non-return maximum.</label>
                                <button className={`${btn} bg-red-700 text-white`}>Charge non-return</button>
                              </form>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          {/* ── Tickets + refunds ────────────────────────────────── */}
          <div id="customer-support" className="scroll-mt-40 grid gap-6 xl:grid-cols-2">
            <section aria-label="Support tickets" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Support tickets ({c.tickets.length})</h2></div>
              {c.tickets.length === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No support tickets.</p>
              ) : (
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                    <tr>{["Ticket", "Category", "State", "Opened", ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {c.tickets.map((t) => (
                      <tr key={t.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                        <td className="px-4 py-3 font-bold">{t.ticket_number}{t.rental_ref && <p className="text-xs font-semibold text-graphite">{t.rental_ref}</p>}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{t.category}</td>
                        <td className="px-4 py-3"><Pill tone={TICKET_TONE[t.state as keyof typeof TICKET_TONE] ?? "mist"}>{t.state.replace(/_/g, " ")}</Pill></td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(t.created_at)}</td>
                        <td className="px-4 py-3"><Link href={`/admin/support/${t.ticket_number}`} className={`${btn} inline-flex items-center bg-mist hover:bg-lime`}>Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <div className="space-y-6">
              <section aria-label="Refunds" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Refund requests ({c.refundRequests.length})</h2>
                {c.refundRequests.length === 0 ? (
                  <p className="mt-3 text-sm text-graphite">No refund requests. Refunds are requested from inside a ticket — open one above or create one.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {c.refundRequests.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3 rounded-xl bg-mist/50 px-4 py-3 text-sm">
                        <div><p className="font-bold">{fmt(r.amount_cents)} · {r.rental_ref}</p><p className="text-xs text-graphite">{r.reason.replace(/_/g, " ")} · {when(r.created_at)}</p></div>
                        <Pill tone={REFUND_TONE[r.status as keyof typeof REFUND_TONE] ?? "mist"}>{r.status}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
                {c.refundRequests.length > 0 && <p className="mt-3 text-xs"><Link href="/admin/support/refunds" className="font-bold underline">Refund queue →</Link></p>}
              </section>

              <section aria-label="Disputes" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Card disputes ({c.disputes.length})</h2>
                {c.disputes.length === 0 ? <p className="mt-3 text-sm text-graphite">No disputes on this customer's payments.</p> : (
                  <ul className="mt-3 space-y-2">
                    {c.disputes.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-3 rounded-xl bg-mist/50 px-4 py-3 text-sm">
                        <div><p className="font-bold">Dispute on payment</p><p className="text-xs text-graphite">Opened {when(d.opened_at)}{d.resolved_at ? ` · resolved ${when(d.resolved_at)}` : ""}</p></div>
                        <Pill tone={d.resolved_at ? "mist" : "red"}>{d.status ?? "open"}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-xs"><Link href="/admin/disputes" className="font-bold underline">Disputes console →</Link></p>
              </section>
            </div>
          </div>

          {/* ── Comms + privacy ──────────────────────────────────── */}
          <div id="customer-comms" className="scroll-mt-40 grid gap-6 xl:grid-cols-2">
            <section aria-label="Recent SMS" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Recent texts ({c.sms.length})</h2>
              {c.sms.length === 0 ? (
                <p className="mt-3 text-sm text-graphite">No SMS traffic on this customer's numbers. Full log lives under <Link href="/admin/sms" className="font-bold underline">SMS log</Link>.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {c.sms.map((m) => (
                    <li key={m.id} className="rounded-xl bg-mist/50 px-4 py-3 text-sm">
                      <p className="whitespace-pre-wrap">{m.direction === "inbound" ? "← " : "→ "}{m.body}</p>
                      <p className="mt-1 text-xs text-graphite">{m.direction} · {m.status} · {when(m.created_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Privacy" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Privacy requests ({c.privacyRequests.length})</h2>
              {c.privacyRequests.length === 0 ? (
                <p className="mt-3 text-sm text-graphite">No export or deletion requests for this customer.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {c.privacyRequests.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 rounded-xl bg-mist/50 px-4 py-3 text-sm">
                      <div><p className="font-bold">{p.kind}</p><p className="text-xs text-graphite">{when(p.created_at)}</p></div>
                      <Pill tone={p.status === "pending" ? "gold" : "mist"}>{p.status}</Pill>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-graphite">Pending requests are actioned from <Link href="/admin/users" className="font-bold underline">Users &amp; roles</Link>.</p>
            </section>
          </div>
        </div>
      )}
    </AdminGate>
  );
}
