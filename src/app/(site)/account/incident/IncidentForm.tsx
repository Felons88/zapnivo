"use client";
import { useRef, useState } from "react";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

export function IncidentForm({ rental }: { rental: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const errRef = useRef<HTMLParagraphElement>(null);
  const fail = (m: string) => { setErr(m); setSending(false); queueMicrotask(() => errRef.current?.focus()); };

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true); setErr(null);
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/incidents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rental: String(f.get("rental") ?? "").trim(), kind: f.get("kind"), description: String(f.get("description") ?? "") }),
    }).catch(() => null);
    if (!res) return fail("We couldn't reach the server. Please try again.");
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { window.location.href = "/login"; return; }
    if (!res.ok) return fail(data.error ?? "We couldn't submit your report. Please try again.");
    setSending(false); setTicket(data.ticketNumber);
  }

  if (ticket) {
    return (
      <div role="status">
        <p className="text-lg font-bold">Report received.</p>
        <p className="mt-2 text-graphite">Your ticket number is {ticket}. We will reply by email.</p>
        <p className="mt-4"><a className="font-bold underline" href="/account">Back to your rentals</a></p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <label htmlFor="rental" className="mb-1.5 block text-sm font-bold">Rental reference</label>
        <input id="rental" name="rental" defaultValue={rental} required pattern="ZR-[A-Za-z0-9]{8}" placeholder="ZR-1A2B3C4D" className={inputCls} />
      </div>
      <div>
        <label htmlFor="kind" className="mb-1.5 block text-sm font-bold">What happened?</label>
        <select id="kind" name="kind" defaultValue="lost" className={inputCls}>
          <option value="lost">Lost</option>
          <option value="damaged">Damaged</option>
          <option value="stolen">Stolen</option>
          <option value="other">Something else</option>
        </select>
      </div>
      <div>
        <label htmlFor="description" className="mb-1.5 block text-sm font-bold">Details</label>
        <textarea id="description" name="description" required minLength={10} maxLength={2000} rows={5} className={inputCls} />
        <p className="mt-1 text-xs text-graphite/80">Please do not include payment card numbers.</p>
      </div>
      <p ref={errRef} tabIndex={-1} role="alert" aria-live="assertive" className="text-sm font-semibold text-red-700 empty:hidden">{err}</p>
      <button type="submit" disabled={sending} className={btnClass("dark", "w-full")}>{sending ? "Submitting..." : "Submit report"}</button>
    </form>
  );
}
