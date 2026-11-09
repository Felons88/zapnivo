"use client";
import Link from "next/link";
import { useState } from "react";
import type { RentalResult } from "@/lib/rental-lookup";
import { fmt } from "@/lib/pricing";
import { btnClass, Eyebrow } from "./ui";
import { inputCls } from "./forms";

type Tab = "rental" | "ticket";
type Mode = "ref" | "when";
type Msg = { kind: "error" | "info"; text: string } | null;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
const STATE_LABEL: Record<string, string> = { open: "Received", pending_customer: "Waiting for your reply", pending_internal: "In progress", resolved: "Resolved", closed: "Closed" };
const TONE = { ok: "bg-lime text-ink", info: "bg-cyan text-ink", warn: "bg-gold text-ink" } as const;

const Label = ({ id, children, hint }: { id: string; children: React.ReactNode; hint?: string }) => (
  <div className="mb-1.5"><label htmlFor={id} className="block text-sm font-bold">{children}</label>{hint && <p className="text-xs text-graphite/70">{hint}</p>}</div>
);

export function RentalCard({ r }: { r: RentalResult }) {
  const q = new URLSearchParams({ rental: r.reference, category: r.suggestRefund ? "Refund request" : r.ticketCategory, station: r.station });
  return (
    <article className="rounded-xl border border-mist bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="eyebrow text-forest/60">Rental reference</p><p className="font-display text-2xl font-bold tracking-tight">{r.reference}</p></div>
        <span className={`rounded-full px-3 py-1 text-xs font-extrabold uppercase tracking-wider ${TONE[r.tone]}`}>{r.status}</span>
      </div>
      <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div><dt className="font-bold text-graphite/70">Station</dt><dd>{r.station}</dd></div>
        <div><dt className="font-bold text-graphite/70">Started</dt><dd>{when(r.startedAt)}</dd></div>
        <div><dt className="font-bold text-graphite/70">Returned</dt><dd>{r.returnedAt ? when(r.returnedAt) : "Not recorded"}</dd></div>
        <div><dt className="font-bold text-graphite/70">Charge</dt><dd>{r.charge}</dd></div>
        {r.expectedCents != null && <div><dt className="font-bold text-graphite/70">Published rate for this period</dt><dd>{fmt(r.expectedCents)} before taxes</dd></div>}
      </dl>
      <p className="mt-5 rounded-lg bg-mist/70 p-4 text-sm leading-6 text-graphite">{r.explanation}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        {r.suggestRefund && <Link href={`/support/new?${q}`} className={btnClass("dark", "min-h-11 text-sm")}>Request a refund review</Link>}
        {r.canReportProblem && <Link href={`/support/new?${q}`} className={btnClass(r.suggestRefund ? "ghost" : "dark", "min-h-11 text-sm")}>Report a problem</Link>}
      </div>
    </article>
  );
}

export function SupportTools() {
  const [tab, setTab] = useState<Tab>("rental");
  const [mode, setMode] = useState<Mode>("ref");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [rentals, setRentals] = useState<RentalResult[] | null>(null);
  const [ticket, setTicket] = useState<{ number: string; category: string; state: string; createdAt: string; withPerson: boolean; threadUrl: string } | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  async function call(url: string, body: object) {
    setBusy(true); setMsg(null); setRentals(null); setTicket(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg({ kind: res.status === 503 ? "info" : "error", text: data.error ?? "Something went wrong. Please try again." });
      else if (!data.found) setMsg({ kind: "info", text: data.message });
      else return data;
    } catch { setMsg({ kind: "error", text: "Network error. Please try again." }); }
    finally { setBusy(false); }
    return null;
  }

  async function findRental(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, string> = { email: String(f.get("email")) };
    if (mode === "ref") body.reference = String(f.get("reference"));
    else {
      const date = String(f.get("date")), time = String(f.get("time") || "");
      const center = new Date(`${date}T${time || "12:00"}`);
      if (Number.isNaN(center.getTime())) return setMsg({ kind: "error", text: "Enter a valid date." });
      const half = time ? 3 * 3600_000 : 12 * 3600_000;
      body.from = new Date(center.getTime() - half).toISOString();
      body.to = new Date(center.getTime() + half).toISOString();
      const st = String(f.get("station") || "").trim();
      if (st) body.station = st;
    }
    const data = await call("/api/support/rental-lookup", body);
    if (data) setRentals(data.results);
  }

  async function findTicket(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const data = await call("/api/support/ticket-status", { ticketNumber: String(f.get("ticketNumber")), email: String(f.get("email")) });
    if (data) setTicket(data.ticket);
  }

  return (
    <section id="find-rental" className="section-lavender scroll-mt-24 py-20 md:py-28" aria-labelledby="tools-h">
      <div className="container-z">
        <div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr]">
          <div>
            <Eyebrow className="text-forest">Self-service</Eyebrow>
            <h2 id="tools-h" className="display-lg mt-5">Find your rental.</h2>
            <p className="lead mt-5 text-graphite">Charged something that doesn't look right, or a power bank didn't dispense? Look up the rental and we'll show what the station and payment records say, then guide you to a refund review if needed.</p>
            <ul className="mt-8 space-y-3 text-sm text-graphite">
              {["Use the email from your receipt, so only you can see your rental.", "Have your reference (ZR-XXXXXXXX)? That's fastest.", "No reference? Search by date, approximate time and station.", "We never ask for card numbers, CVV or passwords."].map((t) => <li key={t} className="flex gap-3"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-lime text-xs font-bold" aria-hidden>✓</span>{t}</li>)}
            </ul>
          </div>

          <div className="rounded-[2rem] border border-mist bg-white p-6 shadow-xl md:p-9">
            <div role="tablist" aria-label="Lookup type" className="inline-flex rounded-full bg-mist p-1.5">
              {([["rental", "Find my rental"], ["ticket", "Track a ticket"]] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setMsg(null); setRentals(null); setTicket(null); }} className={`min-h-11 rounded-full px-5 text-sm font-bold transition-colors ${tab === id ? "bg-forest text-white" : "text-graphite hover:text-ink"}`}>{label}</button>
              ))}
            </div>

            {tab === "rental" ? (
              <form onSubmit={findRental} className="mt-7 space-y-5">
                <div>
                  <Label id="lk-email">Email used at checkout</Label>
                  <input id="lk-email" name="email" type="email" required autoComplete="email" className={inputCls} />
                </div>
                <div role="group" aria-label="Search by" className="flex gap-2">
                  {([["ref", "I have my reference"], ["when", "Search by date & station"]] as const).map(([id, label]) => (
                    <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)} className={`min-h-10 rounded-full border px-4 text-sm font-bold ${mode === id ? "border-forest bg-forest text-white" : "border-mist bg-white hover:border-forest"}`}>{label}</button>
                  ))}
                </div>
                {mode === "ref" ? (
                  <div>
                    <Label id="lk-ref" hint="Printed on your receipt email.">Rental reference</Label>
                    <input id="lk-ref" name="reference" required placeholder="ZR-1A2B3C4D" maxLength={11} className={`${inputCls} uppercase`} />
                  </div>
                ) : (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div><Label id="lk-date">Date of rental</Label><input id="lk-date" name="date" type="date" required max={today} className={inputCls} /></div>
                    <div><Label id="lk-time" hint="Optional. We search ±3 hours. Leave blank to search the whole day.">Approximate time</Label><input id="lk-time" name="time" type="time" className={inputCls} /></div>
                    <div className="sm:col-span-2"><Label id="lk-station" hint="Venue name or city, to narrow results.">Station or venue (optional)</Label><input id="lk-station" name="station" maxLength={160} className={inputCls} /></div>
                  </div>
                )}
                <button type="submit" disabled={busy} className={btnClass("dark", "w-full disabled:opacity-60 sm:w-auto")}>{busy ? "Searching…" : "Find rental"}</button>
              </form>
            ) : (
              <form onSubmit={findTicket} className="mt-7 space-y-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <div><Label id="tk-num">Ticket number</Label><input id="tk-num" name="ticketNumber" required placeholder="Z-1001" className={`${inputCls} uppercase`} /></div>
                  <div><Label id="tk-email">Email on the ticket</Label><input id="tk-email" name="email" type="email" required autoComplete="email" className={inputCls} /></div>
                </div>
                <button type="submit" disabled={busy} className={btnClass("dark", "w-full disabled:opacity-60 sm:w-auto")}>{busy ? "Checking…" : "Check status"}</button>
              </form>
            )}

            <div aria-live="polite" className="mt-7 space-y-4">
              {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={`rounded-lg p-4 text-sm font-semibold ${msg.kind === "error" ? "bg-red-50 text-red-800" : "bg-mist text-graphite"}`}>{msg.text}{msg.kind === "info" && <> <Link href="/support/new" className="underline">Open a ticket</Link></>}</p>}
              {rentals?.map((r) => <RentalCard key={r.reference} r={r} />)}
              {ticket && (
                <article className="rounded-xl border border-mist p-6">
                  <p className="eyebrow text-forest/60">Ticket</p>
                  <p className="font-display text-2xl font-bold">{ticket.number}</p>
                  <p className="mt-1 text-sm text-graphite">{ticket.category} · opened {when(ticket.createdAt)}</p>
                  <p className="mt-4 inline-block rounded-full bg-lime px-3 py-1 text-xs font-extrabold uppercase tracking-wider">{STATE_LABEL[ticket.state] ?? ticket.state}</p>
                  <p className="mt-3 text-sm text-graphite">{ticket.withPerson ? "A Zapnivo team member is handling this." : "Our assistant is helping with this. You can ask for a person at any time."}</p>
                  <Link href={ticket.threadUrl} className={btnClass("dark", "mt-5 min-h-11 text-sm")}>Open the conversation</Link>
                </article>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
