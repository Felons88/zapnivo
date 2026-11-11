"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { RentalResult } from "@/lib/rental-lookup";
import { trackEvent } from "@/components/Analytics";
import { RentalCard } from "./SupportTools";

type Msg = { role: "user" | "assistant"; content: string; rentals?: RentalResult[]; error?: boolean };
type AuthInfo = { verified: boolean; email: string | null; role: string | null };
type VerifyStep = { stage: "phone" | "code" | "email_sent"; phone: string; busy: boolean; error: string | null };

const GREETING = "Hi, I'm Zapnivo's AI assistant. I can explain pricing, returns and refunds, help venue partners, and look up a rental if you give me the email used at checkout plus your rental reference (or the date and station).";
const PROMPTS = ["How much does a rental cost?", "I returned my charger but I'm still being charged", "Look up my rental", "How do I host a station?"];
const DRAFT_KEY = "zapnivo_chat_draft";

export function AssistantChat() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [verify, setVerify] = useState<VerifyStep | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const openIt = () => { setOpen(true); trackEvent("support_chat_opened"); };
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

  // Restore the conversation stashed before the OTP sign-in redirect (same tab, same origin).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      sessionStorage.removeItem(DRAFT_KEY);
      const draft = JSON.parse(raw) as { role?: string; content?: string }[];
      const restored = (Array.isArray(draft) ? draft : [])
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .slice(-10)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));
      if (restored.length) { setMsgs(restored); setOpen(true); }
    } catch { /* corrupt draft — ignore */ }
  }, []);

  async function send(content: string) {
    const q = content.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: q }];
    setMsgs(next); setText(""); setBusy(true);
    trackEvent("support_question_submitted");
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      const res = await fetch("/api/support/assistant", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.current.signal,
        body: JSON.stringify({ messages: next.filter((m) => !m.error).slice(-10).map(({ role, content }) => ({ role, content })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.auth && typeof data.auth === "object") setAuth(data.auth as AuthInfo);
      if (!res.ok) setMsgs([...next, { role: "assistant", content: data.error ?? "Something went wrong. Please try again.", error: true }]);
      else setMsgs([...next, { role: "assistant", content: data.reply, rentals: data.rentals }]);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setMsgs([...next, { role: "assistant", content: "Network error. Please try again.", error: true }]);
    } finally { setBusy(false); }
  }

  /* ── In-chat phone OTP verification (passwordless sign-in) ────────────────
     The OTP lives only in this form — it is never added to the chat messages
     sent to /api/support/assistant. */
  function openVerify() {
    setVerify({ stage: "phone", phone: phone || "", busy: false, error: null });
    setCode("");
  }

  async function verifySend() {
    const p = phone.trim();
    if (!p || verify?.busy) return;
    setVerify({ stage: "phone", phone: p, busy: true, error: null });
    try {
      const res = await fetch("/api/auth/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", phone: p }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setVerify({ stage: "phone", phone: p, busy: false, error: data.error ?? "Couldn't send the code. Try again." });
      else setVerify({ stage: "code", phone: p, busy: false, error: null });
    } catch {
      setVerify({ stage: "phone", phone: p, busy: false, error: "Network error. Please try again." });
    }
  }

  async function verifyCheck() {
    const c = code.replace(/\D/g, "");
    if (c.length !== 6 || !verify || verify.busy) return;
    setVerify({ ...verify, busy: true, error: null });
    try {
      const res = await fetch("/api/auth/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", phone: verify.phone, code: c }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setVerify({ ...verify, busy: false, error: data.error ?? "Wrong or expired code." });
        return;
      }
      if (typeof data.continue_url === "string" && data.continue_url) {
        // Bound phone → straight to a session. Keep the conversation across the redirect.
        try {
          sessionStorage.setItem(DRAFT_KEY, JSON.stringify(msgs.filter((m) => !m.error).slice(-10).map(({ role, content }) => ({ role, content }))));
        } catch { /* storage unavailable — user can retype */ }
        window.location.assign(data.continue_url);
        return;
      }
      if (data.sent === "email_link") {
        setVerify({ stage: "email_sent", phone: verify.phone, busy: false, error: null });
        return;
      }
      setVerify({ ...verify, busy: false, error: "Verification didn't complete. Please try again." });
    } catch {
      setVerify({ ...verify, busy: false, error: "Network error. Please try again." });
    }
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

          {auth?.verified ? (
            <p className="border-t border-mist bg-lime/15 px-4 py-2 text-center text-xs font-bold text-forest" role="status">
              Verified as {auth.email ?? "your account"} · session expires in ≤24h — account tools are on.
            </p>
          ) : verify ? (
            <div className="space-y-3 border-t border-mist bg-white px-4 py-3" data-testid="chat-verify">
              {verify.stage === "phone" && (
                <>
                  <p className="text-sm font-bold">Verify your account</p>
                  <p className="text-xs leading-5 text-graphite">Enter the phone number on your rentals. We'll text you a 6-digit code — it never goes into the chat.</p>
                  <div className="flex gap-2">
                    <label htmlFor="verify-phone" className="sr-only">Phone number</label>
                    <input id="verify-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(320) 555-0100" className="min-h-11 flex-1 rounded-xl border border-silver/70 px-3 text-sm" />
                    <button type="button" onClick={verifySend} disabled={verify.busy || !phone.trim()} className="min-h-11 rounded-xl bg-forest px-4 text-sm font-bold text-white disabled:opacity-40">{verify.busy ? "Sending…" : "Text me a code"}</button>
                  </div>
                </>
              )}
              {verify.stage === "code" && (
                <>
                  <p className="text-sm font-bold">Enter the 6-digit code</p>
                  <p className="text-xs leading-5 text-graphite">Sent to {verify.phone}. It expires in 10 minutes.</p>
                  <div className="flex gap-2">
                    <label htmlFor="verify-code" className="sr-only">Verification code</label>
                    <input id="verify-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="••••••" className="min-h-11 w-32 rounded-xl border border-silver/70 px-3 text-center font-mono text-lg tracking-[0.3em]" />
                    <button type="button" onClick={verifyCheck} disabled={verify.busy || code.length !== 6} className="min-h-11 rounded-xl bg-forest px-4 text-sm font-bold text-white disabled:opacity-40">{verify.busy ? "Checking…" : "Verify"}</button>
                    <button type="button" onClick={() => setVerify({ stage: "phone", phone: verify.phone, busy: false, error: null })} className="min-h-11 rounded-xl border border-silver/70 px-3 text-sm font-bold">Change number</button>
                  </div>
                </>
              )}
              {verify.stage === "email_sent" && (
                <>
                  <p className="text-sm font-bold">Check your email</p>
                  <p className="text-xs leading-5 text-graphite">We texted your code and it checked out. We just emailed a sign-in link to the address on your rental — open it to finish verifying, then come back here.</p>
                  <button type="button" onClick={() => setVerify(null)} className="min-h-11 rounded-xl border border-silver/70 px-4 text-sm font-bold">Back to chat</button>
                </>
              )}
              {verify.error && <p className="text-xs font-bold text-red-700" role="alert">{verify.error}</p>}
              {verify.stage !== "email_sent" && (
                <button type="button" onClick={() => setVerify(null)} className="text-xs font-bold text-graphite underline">Cancel — keep chatting signed out</button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 border-t border-mist bg-white px-4 py-2">
              <button type="button" onClick={openVerify} className="text-xs font-bold text-forest underline underline-offset-2">Verify my account</button>
            </div>
          )}

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
