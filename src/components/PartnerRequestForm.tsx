"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PARTNER_CATEGORIES } from "@/lib/helpdesk/types";
import { btnClass } from "./ui";
import { inputCls } from "./forms";

export function PartnerRequestForm({ venues }: { venues: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/partners/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: f.get("category"), description: f.get("description"), venueLabel: f.get("venue") || undefined }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setErr(data.error ?? "Something went wrong.");
      else { form.reset(); router.push(`/partners/support/${data.ticketNumber}`); }
    } catch { setErr("Network error. Please try again."); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div><label htmlFor="pr-cat" className="mb-1.5 block text-sm font-bold">What do you need help with?</label>
        <select id="pr-cat" name="category" required defaultValue="" className={inputCls}><option value="" disabled>Select…</option>{PARTNER_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
      {venues.length > 0 && <div><label htmlFor="pr-venue" className="mb-1.5 block text-sm font-bold">Venue / station</label>
        <select id="pr-venue" name="venue" className={inputCls}>{venues.map((v) => <option key={v}>{v}</option>)}</select></div>}
      <div><label htmlFor="pr-desc" className="mb-1.5 block text-sm font-bold">Details</label>
        <textarea id="pr-desc" name="description" required minLength={10} maxLength={3000} rows={5} placeholder="What's happening, since when, and anything you've already tried?" className={inputCls} /></div>
      <p className="rounded-lg bg-gold/30 p-3 text-xs font-semibold">If a unit is hot, smoking, swollen or sparking: move people away from it, then call 911 if anyone is in danger. Please don't move or open the station.</p>
      {err && <p role="alert" className="text-sm font-semibold text-red-700">{err}</p>}
      <button type="submit" disabled={busy} className={btnClass("dark", "disabled:opacity-60")}>{busy ? "Sending…" : "Send to partner relations"}</button>
    </form>
  );
}
