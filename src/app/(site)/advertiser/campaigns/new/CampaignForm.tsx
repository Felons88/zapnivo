"use client";
import { useMemo, useState } from "react";
import { inputCls } from "@/components/forms";
import { btnClass } from "@/components/ui";
import type { EligibleStation } from "@/lib/ads/service";

type RateCardOpt = {
  id: string; placement: string; pricing_model: string;
  unit_price_cents: number; min_spend_cents: number; duration_days: number; note: string | null;
};
type Objective = { value: string; label: string };

type State = { status: "idle" | "sending" | "done" | "error"; message?: string };

const PLACEMENT_LABEL: Record<string, string> = { kiosk_screen: "Kiosk screens", website: "Website", email: "Email", event: "Events" };
const MODEL_LABEL: Record<string, string> = { fixed: "fixed flight", cpm: "per 1,000 impressions", cpc: "per click" };
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function CampaignForm({ orgId, rateCards, stations, objectives }: {
  orgId: string;
  rateCards: RateCardOpt[];
  stations: EligibleStation[];
  objectives: Objective[];
}) {
  const [s, setS] = useState<State>({ status: "idle" });
  const [cardId, setCardId] = useState(rateCards[0]?.id ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const card = rateCards.find((r) => r.id === cardId) ?? null;

  // Group stations by city → venue for the market picker.
  const groups = useMemo(() => {
    const map = new Map<string, Map<string, EligibleStation[]>>();
    for (const st of stations) {
      const city = st.city || "Other";
      const venue = st.venueName || "Station";
      if (!map.has(city)) map.set(city, new Map());
      const venues = map.get(city)!;
      if (!venues.has(venue)) venues.set(venue, []);
      venues.get(venue)!.push(st);
    }
    return [...map.entries()].map(([city, venues]) => ({ city, venues: [...venues.entries()] }));
  }, [stations]);

  const flightDays = startsAt && endsAt && Date.parse(endsAt) > Date.parse(startsAt)
    ? Math.max(1, Math.ceil((Date.parse(endsAt) - Date.parse(startsAt)) / 86_400_000))
    : card?.duration_days ?? 7;
  const estimateCents = card?.pricing_model === "fixed"
    ? Math.max(card.unit_price_cents * flightDays, card.min_spend_cents)
    : card ? card.min_spend_cents : null;

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleVenue = (ids: string[]) => setSelected((prev) => {
    const next = new Set(prev);
    const all = ids.every((i) => next.has(i));
    for (const i of ids) { if (all) next.delete(i); else next.add(i); }
    return next;
  });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!card) return setS({ status: "error", message: "Pick a placement first." });
    const fd = new FormData(e.currentTarget);
    const budgetRaw = String(fd.get("budget") ?? "").replace(/[$,\s]/g, "");
    const budgetCents = budgetRaw ? Math.round(parseFloat(budgetRaw) * 100) : undefined;
    if (budgetRaw && (!Number.isFinite(budgetCents) || (budgetCents ?? 0) < 0)) {
      return setS({ status: "error", message: "Enter a valid budget." });
    }
    setS({ status: "sending" });
    const venueIds = [...new Set(stations.filter((st) => selected.has(st.id)).map((st) => st.venueId).filter((v): v is string => !!v))];
    try {
      const res = await fetch("/api/advertiser/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          org_id: orgId,
          name: fd.get("name"),
          objective: fd.get("objective"),
          pricing_model: card.pricing_model,
          placement: card.placement,
          budget_cents: budgetCents,
          targeting: { station_ids: [...selected], venue_ids: venueIds },
          schedule: {
            starts_at: startsAt ? new Date(`${startsAt}T00:00:00`).toISOString() : undefined,
            ends_at: endsAt ? new Date(`${endsAt}T23:59:59`).toISOString() : undefined,
            timezone: "America/Chicago",
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.id) { window.location.href = `/advertiser/campaigns/${data.id}`; return; }
      setS({ status: "error", message: data.error ?? "Couldn't create the campaign." });
    } catch {
      setS({ status: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <form onSubmit={submit} className="space-y-8">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className="mb-1.5 block text-sm font-bold">Campaign name</label>
          <input id="name" name="name" required maxLength={160} placeholder="e.g. Summer nights launch" className={inputCls} />
        </div>
        <div>
          <label htmlFor="objective" className="mb-1.5 block text-sm font-bold">Objective</label>
          <select id="objective" name="objective" required defaultValue="" className={inputCls}>
            <option value="" disabled>Select…</option>
            {objectives.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <fieldset>
        <legend className="text-sm font-bold">Placement &amp; pricing</legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {rateCards.map((r) => (
            <label key={r.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 text-sm ${cardId === r.id ? "border-ink bg-mist/50" : "border-mist bg-white hover:border-silver"}`}>
              <input type="radio" name="rate_card" value={r.id} checked={cardId === r.id} onChange={() => setCardId(r.id)} className="mt-1 h-4 w-4 accent-ink" />
              <span>
                <b className="block">{PLACEMENT_LABEL[r.placement] ?? r.placement}</b>
                <span className="text-graphite">{MODEL_LABEL[r.pricing_model] ?? r.pricing_model} · {money(r.unit_price_cents)}/unit · min {money(r.min_spend_cents)}</span>
                {r.note && <span className="mt-1 block text-xs text-graphite">{r.note}</span>}
              </span>
            </label>
          ))}
        </div>
        {card?.pricing_model === "cpm" || card?.pricing_model === "cpc" ? (
          <p className="mt-3 text-sm text-graphite">This placement is priced per impression/click — we'll confirm final pricing during review.</p>
        ) : estimateCents != null ? (
          <p className="mt-3 text-sm text-graphite">Estimated flight price: <b>{money(estimateCents)}</b> ({flightDays}-day minimum shown; final price confirmed at checkout).</p>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className="text-sm font-bold">Markets</legend>
        <p className="mt-1 text-xs text-graphite">Only online stations at published venues are listed.</p>
        <div className="mt-3 max-h-80 space-y-4 overflow-y-auto rounded-xl border border-mist p-4">
          {groups.map((g) => (
            <div key={g.city}>
              <p className="text-xs font-extrabold uppercase tracking-wider text-forest">{g.city}</p>
              {g.venues.map(([venue, sts]) => (
                <div key={venue} className="mt-2">
                  <label className="flex items-center gap-2 text-sm font-bold">
                    <input type="checkbox" className="h-4 w-4 accent-ink"
                      checked={sts.every((st) => selected.has(st.id))}
                      onChange={() => toggleVenue(sts.map((st) => st.id))} />
                    {venue} <span className="font-medium text-graphite">· {sts[0]?.venueType}</span>
                  </label>
                  <ul className="ml-6 mt-1 space-y-1">
                    {sts.map((st) => (
                      <li key={st.id}>
                        <label className="flex items-center gap-2 text-sm text-graphite">
                          <input type="checkbox" className="h-4 w-4 accent-ink" checked={selected.has(st.id)} onChange={() => toggle(st.id)} />
                          Station {st.stationId}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-graphite">{selected.size} station{selected.size === 1 ? "" : "s"} selected. Leave all unchecked to target the whole eligible network.</p>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-bold">Schedule</legend>
        <div className="mt-3 grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="starts_at" className="mb-1.5 block text-sm font-bold">Start date</label>
            <input id="starts_at" type="date" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="ends_at" className="mb-1.5 block text-sm font-bold">End date</label>
            <input id="ends_at" type="date" required value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={inputCls} />
          </div>
        </div>
        <p className="mt-2 text-xs text-graphite">Times are Central Time. Daypart scheduling is available during campaign review.</p>
      </fieldset>

      <div>
        <label htmlFor="budget" className="mb-1.5 block text-sm font-bold">Budget (USD)</label>
        <input id="budget" name="budget" inputMode="decimal" placeholder={estimateCents != null ? (estimateCents / 100).toFixed(2) : "e.g. 500.00"} className={`${inputCls} sm:max-w-xs`} />
        <p className="mt-1 text-xs text-graphite">Leave blank to use the rate-card price{card?.min_spend_cents ? ` (minimum ${money(card.min_spend_cents)})` : ""}.</p>
      </div>

      {s.status === "error" && <p role="alert" className="rounded-md bg-red-50 p-4 text-sm font-semibold text-red-800">{s.message}</p>}
      <button type="submit" disabled={s.status === "sending"} className={btnClass("dark", "w-full disabled:opacity-60 sm:w-auto")}>
        {s.status === "sending" ? "Creating…" : "Create draft campaign"}
      </button>
      <p className="text-xs text-graphite">Drafts aren't billed. You'll add creatives, then submit for review and payment.</p>
    </form>
  );
}
