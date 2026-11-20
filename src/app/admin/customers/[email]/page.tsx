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

export default async function Customer360({ params, searchParams }: { params: Promise<{ email: string }>; searchParams: Promise<{ result?: string; detail?: string; all?: string }> }) {
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
  const openTickets = c?.tickets.filter((t) => !["resolved", "closed"].includes(t.state)) ?? [];
  const rentalsOut = c?.rentals.filter((r) => isOpen(r)) ?? [];
  const pendingRefunds = c?.refundRequests.filter((r) => ["requested", "approved", "failed"].includes(r.status)) ?? [];
  const openDisputes = c?.disputes.filter((d) => !d.resolved_at) ?? [];
  const latestTicket = openTickets[0];
  const latestRental = rentalsOut[0];
  const nextStep = latestTicket
    ? { title: "Continue the open conversation", detail: `${latestTicket.ticket_number} · ${latestTicket.category} · ${latestTicket.state.replace(/_/g, " ")}`, href: `/admin/support/${latestTicket.ticket_number}`, action: "Open ticket" }
    : latestRental
      ? { title: "Review the rental still in progress", detail: `${latestRental.reference} · ${latestRental.state.replace(/_/g, " ")}`, href: `/admin/rentals/${latestRental.id}`, action: "Review rental" }
      : pendingRefunds[0]
        ? { title: "Review the refund request", detail: `${pendingRefunds[0].rental_ref} · ${pendingRefunds[0].status}`, href: "#customer-support", action: "Review request" }
        : { title: "No active case on this record", detail: "Review recent activity or open a new ticket to document a customer issue.", href: "#customer-actions", action: "Open a ticket" };
  const activity = c ? [
    ...c.tickets.map((t) => ({ id: `ticket-${t.id}`, at: t.created_at, title: `Ticket ${t.ticket_number} opened`, detail: `${t.category} · ${t.state.replace(/_/g, " ")}`, href: `/admin/support/${t.ticket_number}` })),
    ...c.rentals.map((r) => ({ id: `rental-${r.id}`, at: r.created_at, title: `Rental ${r.reference}`, detail: `${r.state.replace(/_/g, " ")} · ${r.kiosks?.venues?.name ?? r.kiosks?.station_id ?? "Station unknown"}`, href: `/admin/rentals/${r.id}` })),
    ...c.notes.map((n) => ({ id: `note-${n.id}`, at: n.created_at, title: "Staff note added", detail: n.author_email ?? "Staff", href: "#customer-actions" })),
    ...c.refundRequests.map((r) => ({ id: `refund-${r.id}`, at: r.created_at, title: `Refund request for ${r.rental_ref}`, detail: `${fmt(r.amount_cents)} · ${r.status}`, href: "#customer-support" })),
    ...(c.wallet?.topups ?? []).map((t) => ({ id: `topup-${t.id}`, at: t.created_at, title: `Wallet top-up ${t.status}`, detail: fmt(t.amount_cents), href: "#customer-wallet" })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12) : [];

  return (
    <AdminGate title={c?.names[0] ?? email} nav="customers">
      {!db ? (
        <EmptyCard title="Customer data not connected">Connect Supabase to see customer records.</EmptyCard>
      ) : !c ? (
        <EmptyCard title="Not a valid customer">“{email}” isn't a recognizable customer email. <Link href="/admin/customers" className="underline">Search again</Link>.</EmptyCard>
      ) : (
        <div className="space-y-4">
          {feedback.result && (
            <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" || feedback.result === "flagged" ? "bg-red-100 text-red-900" : "bg-[#635bff] text-white"}`}>
              {feedback.detail ?? "Done."}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link href="/admin/customers" className="text-sm font-bold text-graphite hover:text-ink">← Customer directory</Link>
            <span className="text-xs font-bold uppercase tracking-widest text-graphite">Staff only · live customer record</span>
          </div>
          <nav aria-label="Customer record sections" className="sticky top-16 z-20 flex gap-1 overflow-x-auto rounded-xl border border-[#e3e8ee] bg-white/95 p-1.5 shadow-sm backdrop-blur">
            {[["Overview", "customer-overview"], ["Resolve", "customer-resolution"], ["Activity", "customer-activity"], ["Rentals", "customer-rentals"], ["Support", "customer-support"], ["Wallet", "customer-wallet"], ["Notes & actions", "customer-actions"], ["Messages", "customer-comms"]].map(([label, target]) =>
              <a key={target} href={`#${target}`} className="shrink-0 rounded-lg px-4 py-2 text-xs font-bold text-forest hover:bg-[#edeeff] focus-visible:bg-[#edeeff]">{label}</a>)}
          </nav>

          {/* ── Identity ─────────────────────────────────────────── */}
          <section id="customer-overview" className="scroll-mt-40 overflow-hidden rounded-2xl bg-[#142126] text-white shadow-sm">
            <div className="border-b border-white/10 px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.18em] text-[#635bff]">Customer intelligence / Unified record</div>
            <div className="p-4 ">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="eyebrow text-[#635bff]">Customer profile</p>
                <h2 className="mt-1 font-display text-xl font-bold tracking-tight">{c.names[0] ?? c.email}</h2>
                <p className="mt-1 text-sm font-semibold text-[#dbe7e3]">{c.email}</p>
                {c.phones.length > 0 && <p className="mt-0.5 text-sm text-[#b7c8c2]">{c.phones.join(" · ")}</p>}
                {c.names.length > 1 && <p className="mt-2 text-xs text-[#b7c8c2]">Also seen as: {c.names.slice(1).join(", ")}</p>}
              </div>
              <div className="text-right text-xs text-[#b7c8c2]">
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
            <div className="mt-7 flex flex-wrap gap-2 border-t border-white/10 pt-5 text-xs font-bold">
              <span className="rounded-full bg-white/10 px-3 py-1.5">{c.rentals.length} rentals</span>
              <span className="rounded-full bg-white/10 px-3 py-1.5">{c.tickets.length} conversations</span>
              <span className="rounded-full bg-white/10 px-3 py-1.5">{c.notes.length} internal notes</span>
              {c.incidents.length > 0 && <span className="rounded-full bg-gold/20 px-3 py-1.5 text-gold">{c.incidents.length} incident reports</span>}
            </div>
            </div>
          </section>

          <section id="customer-resolution" aria-label="Issue resolution" className="scroll-mt-40 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
            <div className="rounded-2xl border border-[#cddbcf] bg-[#eaf2e9] p-4 md:p-7">
              <p className="eyebrow text-forest">Resolution desk</p>
              <h2 className="mt-1 text-xl font-bold tracking-tight">{nextStep.title}</h2>
              <p className="mt-2 text-sm text-graphite">{nextStep.detail}</p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Link href={nextStep.href} className="inline-flex min-h-10 items-center rounded-lg bg-[#0a2540] px-4 text-sm font-bold text-white hover:bg-forest">{nextStep.action} →</Link>
                <a href="#customer-activity" className="inline-flex min-h-10 items-center rounded-lg border border-[#b9c9ba] bg-white px-4 text-sm font-bold text-ink hover:bg-[#edeeff]">Review timeline</a>
              </div>
            </div>
            <div className="rounded-2xl border border-[#e3e8ee] bg-white p-4 md:p-7">
              <p className="eyebrow text-forest">Case signals</p>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between gap-3 border-b border-[#e3e8ee] pb-2"><dt>Open tickets</dt><dd className="font-bold">{openTickets.length}</dd></div>
                <div className="flex justify-between gap-3 border-b border-[#e3e8ee] pb-2"><dt>Rentals in progress</dt><dd className="font-bold">{rentalsOut.length}</dd></div>
                <div className="flex justify-between gap-3 border-b border-[#e3e8ee] pb-2"><dt>Refunds needing review</dt><dd className="font-bold">{pendingRefunds.length}</dd></div>
                <div className="flex justify-between gap-3"><dt>Open disputes</dt><dd className="font-bold">{openDisputes.length}</dd></div>
              </dl>
            </div>
          </section>

          <section aria-label="Customer summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Rentals" value={c.rentals.length} sub={`${c.totals.activeRentals} active or out`} />
            <Metric label="Lifetime captured" value={fmt(c.totals.capturedCents)} sub={c.totals.refundedCents > 0 ? `${fmt(c.totals.refundedCents)} refunded` : undefined} />
            <Metric label="Support tickets" value={c.tickets.length} sub={`${c.totals.openTickets} open`} />
            <Metric label="Staff notes" value={c.notes.length} sub={c.incidents.length ? `${c.incidents.length} incident report${c.incidents.length === 1 ? "" : "s"}` : undefined} />
          </section>

          <section id="customer-activity" aria-label="Customer activity" className="scroll-mt-40 rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="eyebrow text-silver">Record history</p><h2 className="mt-1 font-display text-lg font-bold">Recent activity</h2></div><span className="text-xs text-graphite">Rentals, support and staff notes</span></div>
            {activity.length === 0 ? <p className="mt-4 text-sm text-graphite">No activity on this record yet.</p> : <ol className="mt-4 divide-y divide-mist">
              {activity.map((item) => <li key={item.id}><Link href={item.href} className="flex gap-4 py-3 hover:text-forest"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-forest" aria-hidden /><span className="min-w-0 flex-1"><span className="block text-sm font-bold">{item.title}</span><span className="block truncate text-xs text-graphite">{item.detail}</span></span><span className="shrink-0 text-xs text-graphite">{when(item.at)}</span></Link></li>)}
            </ol>}
          </section>

          <section id="customer-wallet" aria-label="Customer wallet" className="scroll-mt-40 rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><p className="eyebrow text-forest">Stored charging credit</p><h2 className="mt-1 font-display text-xl font-bold">Wallet & top-ups</h2></div>
              <p className="text-2xl font-black">{c.wallet?.balanceCents == null ? "—" : fmt(c.wallet.balanceCents)}</p>
            </div>
            {!c.profile ? <p className="mt-3 text-sm text-graphite">No signed-in wallet for this guest.</p> : (
              <>
                <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl bg-[#eef1f5]/50 px-4 py-3 text-sm">
                  <span className="font-bold">Prepaid card</span>
                  {c.wallet?.card ? (
                    <>
                      <span className="font-mono">•••• •••• •••• {c.wallet.card.last4}</span>
                      <span className="text-graphite">Expires {String(c.wallet.card.exp_month).padStart(2, "0")}/{String(c.wallet.card.exp_year % 100).padStart(2, "0")}</span>
                      <Pill tone={c.wallet.card.status === "active" ? "lime" : "gold"}>{c.wallet.card.status}</Pill>
                      <span className="text-xs text-graphite">Issued {when(c.wallet.card.issued_at)} · Zapnivo machines only · full number and code are never shown to staff</span>
                    </>
                  ) : <span className="text-graphite">Not issued yet — created the first time the customer opens their wallet.</span>}
                </div>
                {c.profile && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {isAdmin && (
                      <form method="post" action="/api/admin/customers" className="rounded-xl border border-[#e3e8ee] p-3">
                        <input type="hidden" name="action" value="add_funds" /><input type="hidden" name="email" value={c.email} />
                        <p className="text-xs font-extrabold uppercase tracking-wider text-forest">Add funds <span className="text-silver">· admin</span></p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <input name="amountDollars" type="number" min="1" max="200" step="0.01" required placeholder="$25.00" aria-label="Amount in dollars" className="min-h-9 w-24 rounded-lg border border-silver/60 px-2 text-xs" />
                          <input name="reason" required minLength={3} maxLength={200} placeholder="Reason (shown to customer)" aria-label="Reason" className="min-h-9 min-w-0 flex-1 rounded-lg border border-silver/60 px-2 text-xs" />
                          <button className={`${btn} bg-[#0a2540] text-white`}>Add</button>
                        </div>
                      </form>
                    )}
                    <form method="post" action="/api/admin/customers" className="rounded-xl border border-[#e3e8ee] p-3">
                      <input type="hidden" name="action" value="reissue_card" /><input type="hidden" name="email" value={c.email} />
                      <p className="text-xs font-extrabold uppercase tracking-wider text-forest">Reissue prepaid card</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input name="reason" required minLength={3} maxLength={200} placeholder="Why? (e.g. customer lost the card)" aria-label="Reissue reason" className="min-h-9 min-w-0 flex-1 rounded-lg border border-silver/60 px-2 text-xs" />
                        <button className={`${btn} border border-silver/60 hover:border-ink`}>New card</button>
                      </div>
                      <p className="mt-1.5 text-[11px] text-graphite">Retires the old number and issues a fresh one. Balance carries over; a reason is required and audit-logged.</p>
                    </form>
                  </div>
                )}
                {c.wallet?.topups.length === 0 ? <p className="mt-3 text-sm text-graphite">No top-up attempts recorded.</p> : (
                  <ul className="mt-2 divide-y divide-mist">
                    {c.wallet?.topups.map((t) => <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                      <div>
                        <p className="font-bold">{fmt(t.amount_cents)} · <Pill tone={t.status === "paid" ? "lime" : t.status === "failed" ? "red" : "gold"}>{t.status}</Pill></p>
                        <p className="text-xs text-graphite">Started {when(t.created_at)}{t.paid_at ? ` · Stripe webhook confirmed ${when(t.paid_at)}` : t.status === "pending" ? " · awaiting Stripe confirmation" : ""}</p>
                      </div>
                      {t.stripe_payment_intent_id && <span className="font-mono text-xs text-graphite" title="Stripe reference (last 8)">…{t.stripe_payment_intent_id.slice(-8)}</span>}
                    </li>)}
                  </ul>
                )}
              </>
            )}
          </section>

          {/* ── Actions ──────────────────────────────────────────── */}
          <div id="customer-actions" className="scroll-mt-40 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
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
                <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Create ticket</button>
              </form>
            </section>

            <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Grant credit</h2>
              <p className="mt-1 text-xs text-graphite">Entitlement credit on the customer&apos;s account — auto-applies on their next rental. The customer is emailed.</p>
              {c.profile ? (
                <form method="post" action="/api/admin/customers" className="mt-4 space-y-3">
                  <input type="hidden" name="action" value="grant_credit" />
                  <input type="hidden" name="email" value={c.email} />
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label htmlFor="gc-amount" className="mb-1 block text-xs font-bold">Amount</label>
                      <input id="gc-amount" name="amount" type="number" min="0.01" step="0.01" required className={`${input} w-full`} placeholder="25.00" />
                    </div>
                    <div>
                      <label htmlFor="gc-unit" className="mb-1 block text-xs font-bold">Unit</label>
                      <select id="gc-unit" name="unit" className={input}><option value="cent">dollars</option><option value="minute">minutes</option><option value="rental">rental</option></select>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="gc-note" className="mb-1 block text-xs font-bold">Reason (shown to customer)</label>
                    <input id="gc-note" name="note" maxLength={200} className={`${input} w-full`} placeholder="e.g. Goodwill for the failed dispense" />
                  </div>
                  <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Grant credit</button>
                </form>
              ) : (
                <p className="mt-4 text-sm text-graphite">Guest record — no account profile to attach credit to. Ask the customer to create an account, or issue a refund instead.</p>
              )}
            </section>

            {isAdmin && c.profile && (
              <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
                <h2 className="font-display text-lg font-bold">Edit customer details <span className="ml-2 align-middle text-[10px] font-extrabold uppercase tracking-widest text-silver">admin only</span></h2>
                <p className="mt-1 text-xs text-graphite">Name and phone update instantly. An email change is applied immediately and the customer is told at the new address — every change is audit-logged.</p>
                <form method="post" action="/api/admin/customers" className="mt-4 space-y-3">
                  <input type="hidden" name="action" value="update_profile" />
                  <input type="hidden" name="email" value={c.email} />
                  <div>
                    <label htmlFor="ep-name" className="mb-1 block text-xs font-bold">Full name</label>
                    <input id="ep-name" name="name" defaultValue={c.names[0] ?? ""} maxLength={120} className={`${input} w-full`} />
                  </div>
                  <div>
                    <label htmlFor="ep-phone" className="mb-1 block text-xs font-bold">Phone</label>
                    <input id="ep-phone" name="phone" type="tel" defaultValue={c.phones[0] ?? ""} maxLength={40} className={`${input} w-full`} />
                  </div>
                  <div>
                    <label htmlFor="ep-email" className="mb-1 block text-xs font-bold">New email (leave blank to keep {c.email})</label>
                    <input id="ep-email" name="newEmail" type="email" maxLength={254} className={`${input} w-full`} placeholder="new.address@example.com" />
                  </div>
                  <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Save changes</button>
                </form>
                <div className="mt-4 flex flex-wrap gap-2 border-t border-[#e3e8ee] pt-4">
                  <form method="post" action="/api/admin/customers"><input type="hidden" name="action" value="reset_password" /><input type="hidden" name="email" value={c.email} /><button className={`${btn} border border-silver/60 hover:border-ink`}>Send password reset</button></form>
                  <form method="post" action="/api/admin/customers"><input type="hidden" name="action" value="sign_out_user" /><input type="hidden" name="email" value={c.email} /><button className={`${btn} border border-silver/60 hover:border-ink`}>Sign out everywhere</button></form>
                </div>
              </section>
            )}

            <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Add a staff note</h2>
              <p className="mt-1 text-xs text-graphite">Internal only — attached to this customer and audit-logged. Never emailed.</p>
              <form method="post" action="/api/admin/customers" className="mt-4 space-y-3">
                <input type="hidden" name="action" value="add_note" />
                <input type="hidden" name="email" value={c.email} />
                <textarea name="body" required minLength={2} maxLength={4000} rows={4} className="w-full rounded-lg border border-silver/70 px-3 py-2 text-sm" placeholder="e.g. Customer says kiosk at Demo Tavern ate the bank — verify against slot telemetry before refund…" />
                <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Save note</button>
              </form>

              {c.notes.length > 0 && (
                <ul className="mt-5 space-y-3 border-t border-[#e3e8ee] pt-4">
                  {c.notes.map((n) => (
                    <li key={n.id} className="rounded-xl bg-[#eef1f5]/50 px-4 py-3 text-sm">
                      <p className="whitespace-pre-wrap">{n.body}</p>
                      <p className="mt-1 text-xs text-graphite">{n.author_email ?? "Staff"} · {when(n.created_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* ── Rentals ──────────────────────────────────────────── */}
          <section id="customer-rentals" aria-label="Rentals" className="scroll-mt-40 overflow-x-auto rounded-2xl border border-[#e3e8ee] bg-white shadow-sm">
            <div className="border-b border-[#e3e8ee] px-4 py-4"><h2 className="font-display text-lg font-bold">Rentals ({c.rentals.length})</h2></div>
            {c.rentals.length === 0 ? (
              <p className="px-4 py-8 text-sm text-graphite">No rentals on record for this customer.</p>
            ) : (
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-[#e3e8ee] bg-[#eef1f5]/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Reference", "Station", "State", "Started", "Returned", "Due back", "Payment", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {(feedback.all === "1" ? c.rentals : c.rentals.slice(0, 4)).map((r) => {
                    const od = overdue(r);
                    const incidents = c.incidents.filter((i) => i.rental_id === r.id);
                    return (
                      <tr key={r.id} className="border-b border-[#e3e8ee]/70 align-top last:border-0 hover:bg-[#edeeff]">
                        <td className="px-4 py-3">
                          <p className="font-bold"><Link href={`/admin/rentals/${r.id}`} className="text-forest underline hover:text-ink">{r.reference}</Link></p>
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
                              <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="dispense" /><input type="hidden" name="back" value={back} /><button className={`${btn} bg-[#635bff] text-white`}>Confirm dispense</button></form>
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
                                <input name="amountDollars" type="number" min="0.01" step="0.01" max={((r.payments[0].amount_captured_cents ?? 0) - (r.payments[0].amount_refunded_cents ?? 0)) / 100} required placeholder="$0.00" aria-label="Refund amount in dollars" className="min-h-8 w-20 rounded-lg border border-silver/60 px-1.5 text-xs" />
                                <select name="reason" defaultValue="goodwill" aria-label="Refund reason" className="min-h-8 rounded-lg border border-silver/60 px-1.5 text-xs font-semibold">
                                  {REFUND_REASONS.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ")}</option>)}
                                </select>
                                <button className={`${btn} bg-[#eef1f5] hover:bg-[#edeeff]`}>Refund</button>
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
            {c.rentals.length > 4 && (
              <p className="border-t border-[#e3e8ee] px-4 py-3 text-xs">
                {feedback.all === "1"
                  ? <Link href={`${back}#customer-rentals`} className="font-bold text-forest underline">Show latest 4 only</Link>
                  : <Link href={`${back}?all=1#customer-rentals`} className="font-bold text-forest underline">View all {c.rentals.length} rentals →</Link>}
              </p>
            )}
          </section>

          {/* ── Tickets + refunds ────────────────────────────────── */}
          <div id="customer-support" className="scroll-mt-40 grid gap-4 xl:grid-cols-2">
            <section aria-label="Support tickets" className="overflow-x-auto rounded-2xl border border-[#e3e8ee] bg-white shadow-sm">
              <div className="border-b border-[#e3e8ee] px-4 py-4"><h2 className="font-display text-lg font-bold">Support tickets ({c.tickets.length})</h2></div>
              {c.tickets.length === 0 ? (
                <p className="px-4 py-8 text-sm text-graphite">No support tickets.</p>
              ) : (
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="border-b border-[#e3e8ee] bg-[#eef1f5]/40 text-xs uppercase tracking-wider text-graphite">
                    <tr>{["Ticket", "Category", "State", "Opened", ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {c.tickets.map((t) => (
                      <tr key={t.id} className="border-b border-[#e3e8ee]/70 last:border-0 hover:bg-[#edeeff]">
                        <td className="px-4 py-3 font-bold">{t.ticket_number}{t.rental_ref && <p className="text-xs font-semibold text-graphite">{t.rental_ref}</p>}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{t.category}</td>
                        <td className="px-4 py-3"><Pill tone={TICKET_TONE[t.state as keyof typeof TICKET_TONE] ?? "mist"}>{t.state.replace(/_/g, " ")}</Pill></td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(t.created_at)}</td>
                        <td className="px-4 py-3"><Link href={`/admin/support/${t.ticket_number}`} className={`${btn} inline-flex items-center bg-[#eef1f5] hover:bg-[#edeeff]`}>Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <div className="space-y-4">
              <section aria-label="Refunds" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
                <h2 className="font-display text-lg font-bold">Refund requests ({c.refundRequests.length})</h2>
                {c.refundRequests.length === 0 ? (
                  <p className="mt-3 text-sm text-graphite">No refund requests. Refunds are requested from inside a ticket — open one above or create one.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {c.refundRequests.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3 rounded-xl bg-[#eef1f5]/50 px-4 py-3 text-sm">
                        <div><p className="font-bold">{fmt(r.amount_cents)} · {r.rental_ref}</p><p className="text-xs text-graphite">{r.reason.replace(/_/g, " ")} · {when(r.created_at)}</p></div>
                        <Pill tone={REFUND_TONE[r.status as keyof typeof REFUND_TONE] ?? "mist"}>{r.status}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
                {c.refundRequests.length > 0 && <p className="mt-3 text-xs"><Link href="/admin/support/refunds" className="font-bold underline">Refund queue →</Link></p>}
              </section>

              <section aria-label="Disputes" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
                <h2 className="font-display text-lg font-bold">Card disputes ({c.disputes.length})</h2>
                {c.disputes.length === 0 ? <p className="mt-3 text-sm text-graphite">No disputes on this customer's payments.</p> : (
                  <ul className="mt-3 space-y-2">
                    {c.disputes.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-3 rounded-xl bg-[#eef1f5]/50 px-4 py-3 text-sm">
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
          <div id="customer-comms" className="scroll-mt-40 grid gap-4 xl:grid-cols-2">
            <section aria-label="Recent SMS" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Recent texts ({c.sms.length})</h2>
              {c.sms.length === 0 ? (
                <p className="mt-3 text-sm text-graphite">No SMS traffic on this customer's numbers. Full log lives under <Link href="/admin/sms" className="font-bold underline">SMS log</Link>.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {c.sms.map((m) => (
                    <li key={m.id} className="rounded-xl bg-[#eef1f5]/50 px-4 py-3 text-sm">
                      <p className="whitespace-pre-wrap">{m.direction === "inbound" ? "← " : "→ "}{m.body}</p>
                      <p className="mt-1 text-xs text-graphite">{m.direction} · {m.status} · {when(m.created_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Emails" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Emails sent ({c.emails.length})</h2>
              {c.emails.length === 0 ? <p className="mt-3 text-sm text-graphite">No emails sent to this address yet.</p> : (
                <ul className="mt-3 space-y-2">
                  {c.emails.map((m) => (
                    <li key={m.id}>
                      <Link href={`/admin/emails/${m.id}`} className="flex items-center justify-between gap-3 rounded-xl bg-[#eef1f5]/50 px-4 py-3 text-sm hover:bg-[#edeeff]">
                        <div className="min-w-0"><p className="truncate font-bold">{m.subject}</p><p className="text-xs text-graphite">{when(m.created_at)}{m.error ? ` · ${m.error.slice(0, 80)}` : ""}</p></div>
                        <Pill tone={m.status === "sent" ? "lime" : m.status === "failed" ? "red" : "gold"}>{m.status}</Pill>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Privacy" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Privacy requests ({c.privacyRequests.length})</h2>
              {c.privacyRequests.length === 0 ? (
                <p className="mt-3 text-sm text-graphite">No export or deletion requests for this customer.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {c.privacyRequests.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 rounded-xl bg-[#eef1f5]/50 px-4 py-3 text-sm">
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
