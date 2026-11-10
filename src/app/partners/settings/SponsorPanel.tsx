"use client";
import { useEffect, useState } from "react";

type Campaign = {
  id: string; name: string; status: string; credit_minutes: number; per_customer_minutes: number;
  budget_cents: number | null; spent_cents: number; starts_at: string; ends_at: string; created_at: string;
};

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const STATUS_TONE: Record<string, string> = { pending: "bg-gold/30 text-ink", active: "bg-lime", paused: "bg-mist", completed: "bg-mist", rejected: "bg-red-100 text-red-900" };

/** Sponsored-charging manager for venue partners — create + track funding campaigns. */
export function SponsorPanel({ venues }: { venues: { id: string; name: string }[] }) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const load = () => fetch("/api/partners/sponsors").then((r) => r.json()).then((j) => setCampaigns(j.campaigns ?? [])).catch(() => setCampaigns([]));
  useEffect(() => { void load(); }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("sending"); setError(null);
    const f = e.currentTarget;
    const fd = new FormData(f);
    const venueIds = fd.getAll("venue_ids").map(String);
    const body = {
      name: String(fd.get("name") ?? ""),
      credit_minutes: Number(fd.get("credit_minutes")),
      per_customer_minutes: Number(fd.get("per_customer_minutes")),
      per_day_minutes: fd.get("per_day_minutes") ? Number(fd.get("per_day_minutes")) : undefined,
      budget_cents: fd.get("budget_dollars") ? Math.round(Number(fd.get("budget_dollars")) * 100) : undefined,
      starts_at: new Date(String(fd.get("starts_at"))).toISOString(),
      ends_at: new Date(String(fd.get("ends_at"))).toISOString(),
      venue_ids: venueIds.length ? venueIds : undefined,
    };
    const r = await fetch("/api/partners/sponsors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setState("done"); f.reset(); void load(); }
    else { setState("error"); setError(j.error ?? "Could not create the campaign."); }
  }

  return (
    <div className="mt-6 space-y-6">
      <form onSubmit={submit} className="space-y-4 rounded-xl border border-mist p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label className="mb-1 block text-xs font-bold" htmlFor="sp-name">Campaign name</label>
            <input id="sp-name" name="name" required minLength={3} maxLength={120} placeholder="e.g. Free first 30 min — summer" className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" /></div>
          <div><label className="mb-1 block text-xs font-bold" htmlFor="sp-budget">Budget (USD, optional)</label>
            <input id="sp-budget" name="budget_dollars" type="number" min="0" step="0.01" placeholder="Leave blank for unlimited*" className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" /></div>
          <div><label className="mb-1 block text-xs font-bold" htmlFor="sp-credit">Total credit pool (minutes)</label>
            <input id="sp-credit" name="credit_minutes" type="number" required min={5} max={480} defaultValue={300} className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" /></div>
          <div><label className="mb-1 block text-xs font-bold" htmlFor="sp-per">Per-customer cap (minutes)</label>
            <input id="sp-per" name="per_customer_minutes" type="number" required min={5} max={120} defaultValue={30} className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" /></div>
          <div><label className="mb-1 block text-xs font-bold" htmlFor="sp-perday">Per-customer daily cap (minutes, optional)</label>
            <input id="sp-perday" name="per_day_minutes" type="number" min={5} max={480} placeholder="e.g. 60" className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" /></div>
          <div><label className="mb-1 block text-xs font-bold" htmlFor="sp-start">Starts</label>
            <input id="sp-start" name="starts_at" type="datetime-local" required className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" /></div>
          <div><label className="mb-1 block text-xs font-bold" htmlFor="sp-end">Ends</label>
            <input id="sp-end" name="ends_at" type="datetime-local" required className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" /></div>
        </div>
        {venues.length > 0 && (
          <fieldset>
            <legend className="mb-1 text-xs font-bold">Limit to venues (optional — blank covers all your venues)</legend>
            <div className="flex flex-wrap gap-3">
              {venues.map((v) => (
                <label key={v.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="venue_ids" value={v.id} /> {v.name}</label>
              ))}
            </div>
          </fieldset>
        )}
        <p className="text-xs text-graphite">*Unlimited campaigns still require Zapnivo approval and a signed sponsorship agreement. Customers see the offer on your station page before renting; sponsored minutes are discounted from their final charge automatically.</p>
        {state === "done" && <p role="status" className="rounded-lg bg-lime px-3 py-2 text-sm font-bold">Campaign submitted for review.</p>}
        {state === "error" && <p role="alert" className="rounded-lg bg-red-100 px-3 py-2 text-sm font-bold text-red-900">{error}</p>}
        <button disabled={state === "sending"} className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white hover:bg-forest disabled:opacity-50">
          {state === "sending" ? "Submitting…" : "Submit for approval"}
        </button>
      </form>

      <div>
        <h3 className="font-display text-lg font-bold">Your campaigns</h3>
        {campaigns === null ? <p className="mt-3 text-sm text-graphite">Loading…</p> : campaigns.length === 0 ? (
          <p className="mt-3 text-sm text-graphite">No sponsored-charging campaigns yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {campaigns.map((c) => (
              <li key={c.id} className="rounded-xl border border-mist p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-bold">{c.name}</p>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_TONE[c.status] ?? "bg-mist"}`}>{c.status}</span>
                </div>
                <p className="mt-1 text-xs text-graphite">
                  Up to {c.per_customer_minutes} min per customer · {c.credit_minutes} min pool
                  {c.budget_cents != null ? ` · ${fmt(c.budget_cents)} budget` : ""}
                  {c.spent_cents ? ` · ${fmt(c.spent_cents)} used` : ""}
                  {" · "}{when(c.starts_at)} → {when(c.ends_at)}
                </p>
                {c.status === "pending" && <p className="mt-1 text-xs text-graphite">Awaiting Zapnivo approval before it goes live.</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
