"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { btnClass } from "./ui";

/** Reply box for a ticket owner. Customers use a signed token; partners are authenticated by session. */
export function RequesterReply({ number, token, mode, withPerson, resolved }: { number: string; token?: string; mode: "customer" | "partner"; withPerson: boolean; resolved: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function call(action: "reply" | "human" | "resolve") {
    setBusy(action); setErr(null);
    const [url, body] = mode === "customer"
      ? [`/api/support/thread/${number}`, { action, token, body: text }]
      : [`/api/partners/requests/${number}`, { body: text }];
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setErr(data.error ?? "Something went wrong. Please try again.");
      else { if (action === "reply") setText(""); router.refresh(); }
    } catch { setErr("Network error. Please try again."); }
    setBusy(null);
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) call("reply"); }} className="rounded-2xl border border-mist bg-white p-4 shadow-sm">
      <label htmlFor="reply" className="mb-2 block text-sm font-bold">{resolved ? "Need more help? Reply to reopen this ticket" : "Add a message"}</label>
      <textarea id="reply" value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000} placeholder="Add details, answer a question, or tell us what changed…" className="w-full rounded-xl border border-silver/70 p-3 text-base focus:border-ink" />
      <p className="mt-1 text-xs text-graphite/70">Please don't include card numbers or passwords.</p>
      {err && <p role="alert" className="mt-2 text-sm font-semibold text-red-700">{err}</p>}
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="submit" disabled={!!busy || !text.trim()} className={btnClass("dark", "min-h-11 text-sm disabled:opacity-50")}>{busy === "reply" ? "Sending…" : "Send message"}</button>
        {mode === "customer" && !withPerson && !resolved && <button type="button" disabled={!!busy} onClick={() => call("human")} className={btnClass("ghost", "min-h-11 border-ink/30 text-sm")}>{busy === "human" ? "Requesting…" : "Talk to a person"}</button>}
        {mode === "customer" && !resolved && <button type="button" disabled={!!busy} onClick={() => call("resolve")} className={btnClass("ghost", "min-h-11 border-ink/30 text-sm")}>{busy === "resolve" ? "Saving…" : "This is resolved"}</button>}
      </div>
    </form>
  );
}
