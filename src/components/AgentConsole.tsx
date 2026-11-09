"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { fmt } from "@/lib/pricing";
import { REASON_LABEL, type Suggestion } from "@/lib/helpdesk/refund-policy";
import { PRIORITIES, REFUND_REASONS, STATES, type RefundReason, type RefundRequest } from "@/lib/helpdesk/types";
import { helpdeskPost, RefundActions } from "./RefundActions";

type Props = {
  ticket: { number: string; state: string; priority: string; assignedTo: string | null; rentalRef: string | null };
  me: { id: string; role: "admin" | "staff" };
  aiAvailable: boolean;
  macros: { id: string; title: string; text: string }[];
  suggestions: Record<RefundReason, Suggestion> | null;
  remainingCents: number | null;
  refunds: RefundRequest[];
};

const sel = "min-h-10 rounded-lg border border-silver/70 bg-white px-3 text-sm";

export function AgentConsole({ ticket, me, aiAvailable, macros, suggestions, remainingCents, refunds }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const [reason, setReason] = useState<RefundReason>("failed_dispense");
  const [amount, setAmount] = useState("");
  const [override, setOverride] = useState(false);

  async function call(key: string, body: object, after?: (d: Record<string, unknown>) => void) {
    setBusy(key); setMsg(null);
    const { ok, data } = await helpdeskPost(body);
    setBusy(null);
    if (!ok) return setMsg({ ok: false, text: (data.error as string) ?? "Something went wrong." });
    after?.(data);
    router.refresh();
  }

  const send = (state: "pending_customer" | "pending_internal" | "resolved") =>
    call("send", mode === "note" ? { op: "note", number: ticket.number, body: text } : { op: "reply", number: ticket.number, body: text, state }, () => { setText(""); setWarn([]); setMsg({ ok: true, text: mode === "note" ? "Note added." : "Reply sent." }); });

  const sug = suggestions?.[reason];
  const useSuggested = () => sug && setAmount((sug.suggestedCents / 100).toFixed(2));

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-mist bg-white p-4 shadow-sm" aria-label="Reply">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label="Reply type" className="inline-flex rounded-full bg-mist p-1">
            {(["reply", "note"] as const).map((m) => <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`min-h-9 rounded-full px-4 text-sm font-bold ${mode === m ? "bg-forest text-white" : ""}`}>{m === "reply" ? "Reply to requester" : "Internal note"}</button>)}
          </div>
          {mode === "reply" && (
            <div className="flex flex-wrap gap-2">
              <select aria-label="Insert macro" className={sel} value="" onChange={(e) => { const m = macros.find((x) => x.id === e.target.value); if (m) setText((t) => (t ? `${t}\n\n` : "") + m.text); }}>
                <option value="">Insert macro…</option>{macros.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
              <button type="button" disabled={!aiAvailable || !!busy} title={aiAvailable ? "Draft a reply (never sent automatically)" : "Set OPENROUTER_API_KEY to enable"} onClick={() => call("draft", { op: "draft", number: ticket.number }, (d) => { setText(String(d.text ?? "")); setWarn((d.warnings as string[]) ?? []); })} className="min-h-10 rounded-full bg-lime px-4 text-sm font-bold disabled:opacity-40">{busy === "draft" ? "Drafting…" : "AI draft"}</button>
            </div>
          )}
        </div>
        <label htmlFor="agent-text" className="sr-only">{mode === "reply" ? "Reply" : "Internal note"}</label>
        <textarea id="agent-text" value={text} onChange={(e) => setText(e.target.value)} rows={8} maxLength={4000} placeholder={mode === "reply" ? "Write a reply the requester will see…" : "Only staff can see this note…"} className={`w-full rounded-xl border p-3 text-base focus:border-ink ${mode === "note" ? "border-gold bg-gold/15" : "border-silver/70"}`} />
        {warn.map((w) => <p key={w} role="alert" className="mt-2 rounded-lg bg-gold/40 p-2 text-xs font-semibold">{w}</p>)}
        <div className="mt-3 flex flex-wrap gap-2">
          {mode === "reply" ? (
            <>
              <button disabled={!!busy || !text.trim()} onClick={() => send("pending_customer")} className="min-h-11 rounded-full bg-ink px-5 text-sm font-bold text-white disabled:opacity-40">Send · wait for requester</button>
              <button disabled={!!busy || !text.trim()} onClick={() => send("resolved")} className="min-h-11 rounded-full bg-lime px-5 text-sm font-bold disabled:opacity-40">Send &amp; resolve</button>
              <button disabled={!!busy || !text.trim()} onClick={() => send("pending_internal")} className="min-h-11 rounded-full border border-ink/30 px-5 text-sm font-bold disabled:opacity-40">Send · keep working</button>
            </>
          ) : <button disabled={!!busy || !text.trim()} onClick={() => send("pending_customer")} className="min-h-11 rounded-full bg-ink px-5 text-sm font-bold text-white disabled:opacity-40">Add note</button>}
        </div>
        {msg && <p role="status" className={`mt-3 rounded-lg p-2 text-sm font-semibold ${msg.ok ? "bg-lime/50" : "bg-red-50 text-red-800"}`}>{msg.text}</p>}
      </section>

      <section className="rounded-2xl border border-mist bg-white p-4 shadow-sm" aria-label="Ticket controls">
        <h2 className="font-display text-lg font-bold">Controls</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-bold">Status<select className={`${sel} mt-1 w-full`} value={ticket.state} onChange={(e) => call("state", { op: "state", number: ticket.number, state: e.target.value })}>{STATES.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="text-xs font-bold">Priority<select className={`${sel} mt-1 w-full`} value={ticket.priority} onChange={(e) => call("priority", { op: "priority", number: ticket.number, priority: e.target.value })}>{PRIORITIES.map((s) => <option key={s}>{s}</option>)}</select></label>
          <div className="text-xs font-bold">Owner<div className="mt-1 flex gap-2">
            <button className="min-h-10 flex-1 rounded-lg border border-ink/30 px-2 text-sm" onClick={() => call("assign", { op: "assign", number: ticket.number, assigneeId: ticket.assignedTo === me.id ? null : me.id })}>{ticket.assignedTo === me.id ? "Unassign me" : "Assign to me"}</button></div></div>
        </div>
      </section>

      {ticket.rentalRef && (
        <section className="rounded-2xl border border-mist bg-white p-4 shadow-sm" aria-label="Refunds">
          <h2 className="font-display text-lg font-bold">Refunds · {ticket.rentalRef}</h2>
          {suggestions ? (
            <>
              <p className="mt-1 text-sm text-graphite">Refundable balance: <b>{fmt(remainingCents ?? 0)}</b>. Policy checks run on the server; agents can approve up to {fmt(1299)}, larger amounts need a different admin.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                <select aria-label="Refund reason" className={sel} value={reason} onChange={(e) => { setReason(e.target.value as RefundReason); setAmount(""); }}>{REFUND_REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}</select>
                <input aria-label="Amount in dollars" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$0.00" className={`${sel} w-28`} />
                <button disabled={!!busy || !amount} onClick={() => call("refund", { op: "refund_request", number: ticket.number, rentalRef: ticket.rentalRef, reason, amountCents: Math.round(parseFloat(amount) * 100), override: override || undefined }, () => { setAmount(""); setMsg({ ok: true, text: "Refund requested." }); })} className="min-h-10 rounded-full bg-ink px-4 text-sm font-bold text-white disabled:opacity-40">Request refund</button>
              </div>
              {sug && (
                <p className={`mt-2 rounded-lg p-3 text-xs leading-5 ${sug.eligible ? "bg-lime/40" : "bg-gold/40"}`}>
                  <b>{sug.eligible ? `Policy suggests ${fmt(sug.suggestedCents)}.` : "Not eligible under policy."}</b> {sug.rationale}{" "}
                  {sug.eligible && <button type="button" onClick={useSuggested} className="font-bold underline">Use {fmt(sug.suggestedCents)}</button>}
                </p>
              )}
              {me.role === "admin" && <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Admin override of policy limits (audited)</label>}
            </>
          ) : <p className="mt-2 text-sm text-graphite">Rental {ticket.rentalRef} wasn't found in our records, so no refund can be requested yet.</p>}
          <div className="mt-4 space-y-3">{refunds.map((r) => <RefundActions key={r.id} r={r} role={me.role} myId={me.id} />)}</div>
        </section>
      )}
    </div>
  );
}
