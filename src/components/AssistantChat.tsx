"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { RentalResult } from "@/lib/rental-lookup";
import { RentalCard } from "./SupportTools";

type Msg = { role: "user" | "assistant"; content: string; rentals?: RentalResult[]; error?: boolean };

const GREETING = "Hi, I'm Zapnivo's AI assistant. I can explain pricing, returns and refunds, help venue partners, and look up a rental if you give me the email used at checkout plus your rental reference (or the date and station).";
const PROMPTS = ["How much does a rental cost?", "I returned my charger but I'm still being charged", "Look up my rental", "How do I host a station?"];

export function AssistantChat() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener("zapnivo:open-assistant", openIt);
    return () => window.removeEventListener("zapnivo:open-assistant", openIt);
  }, []);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 50); }, [open]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  useEffect(() => () => abort.current?.abort(), []);

  async function send(content: string) {
    const q = content.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: q }];
    setMsgs(next); setText(""); setBusy(true);
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      const res = await fetch("/api/support/assistant", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.current.signal,
        body: JSON.stringify({ messages: next.filter((m) => !m.error).slice(-10).map(({ role, content }) => ({ role, content })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsgs([...next, { role: "assistant", content: data.error ?? "Something went wrong. Please try again.", error: true }]);
      else setMsgs([...next, { role: "assistant", content: data.reply, rentals: data.rentals }]);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setMsgs([...next, { role: "assistant", content: "Network error. Please try again.", error: true }]);
    } finally { setBusy(false); }
  }

  return (
    <>
      {!open && (
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="fixed bottom-4 right-4 z-[65] flex min-h-14 items-center gap-3 rounded-full bg-forest px-5 font-bold text-white shadow-2xl ring-2 ring-lime/60 transition-transform hover:-translate-y-0.5">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-lime text-ink" aria-hidden><svg width="16" height="16" viewBox="0 0 24 24"><path d="M13 2 5 14h6l-2 8 10-12h-6l2-8Z" fill="currentColor" /></svg></span>
          Ask Zapnivo AI
        </button>
      )}
      {open && (
        <div role="dialog" aria-label="Zapnivo AI assistant" aria-modal="false" className="fixed inset-x-3 bottom-3 z-[75] flex h-[min(680px,calc(100svh-24px))] flex-col overflow-hidden rounded-[1.5rem] border border-mist bg-white shadow-2xl sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[420px]">
          <div className="ambient-hero flex items-center justify-between gap-3 px-5 py-4 text-white">
            <div><p className="font-display text-lg font-bold">Zapnivo assistant</p><p className="text-xs text-white/65">AI · answers from Zapnivo's own help content</p></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close assistant" className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-xl hover:bg-white/20">×</button>
          </div>

          <div ref={log} role="log" aria-live="polite" className="flex-1 space-y-4 overflow-y-auto bg-paper px-4 py-5">
            <p className="max-w-[92%] rounded-2xl rounded-bl-md bg-white p-4 text-sm leading-6 shadow-sm">{GREETING}</p>
            {msgs.length === 0 && <div className="flex flex-wrap gap-2">{PROMPTS.map((p) => <button key={p} type="button" onClick={() => send(p)} className="rounded-full border border-forest/25 bg-white px-3 py-2 text-left text-xs font-bold hover:border-forest">{p}</button>)}</div>}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                <div className={m.role === "user" ? "max-w-[85%] rounded-2xl rounded-br-md bg-forest p-3 text-sm leading-6 text-white" : "max-w-[96%] space-y-3"}>
                  {m.role === "user" ? m.content : (
                    <>
                      <p className={`whitespace-pre-wrap rounded-2xl rounded-bl-md p-4 text-sm leading-6 shadow-sm ${m.error ? "bg-red-50 text-red-800" : "bg-white"}`}>{m.content}</p>
                      {m.rentals?.map((r) => <RentalCard key={r.reference} r={r} />)}
                    </>
                  )}
                </div>
              </div>
            ))}
            {busy && <p className="w-fit rounded-2xl bg-white px-4 py-3 text-sm text-graphite shadow-sm" role="status"><span className="inline-flex gap-1" aria-hidden><span className="charge-led">●</span><span className="charge-led" style={{ ["--d" as string]: "300ms" }}>●</span><span className="charge-led" style={{ ["--d" as string]: "600ms" }}>●</span></span><span className="sr-only">Assistant is typing</span></p>}
          </div>

          <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="border-t border-mist bg-white p-3">
            <div className="flex items-end gap-2">
              <label htmlFor="assistant-input" className="sr-only">Message</label>
              <textarea ref={input} id="assistant-input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} rows={1} maxLength={1000} placeholder="Ask about rentals, refunds, hosting…" className="max-h-28 min-h-12 flex-1 resize-none rounded-2xl border border-silver/70 px-4 py-3 text-sm focus:border-ink" />
              <button type="submit" disabled={busy || !text.trim()} className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-lime font-bold text-ink disabled:opacity-40" aria-label="Send message">→</button>
            </div>
            <p className="mt-2 px-1 text-[11px] leading-4 text-graphite/80">AI can make mistakes. Never share card numbers or passwords. Messages are processed by an AI provider. <Link href="/support/new" className="font-bold underline">Open a ticket</Link> for anything account-specific.</p>
          </form>
        </div>
      )}
    </>
  );
}
