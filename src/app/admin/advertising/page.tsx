export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";
import { fmt } from "@/lib/pricing";

export const metadata: Metadata = { title: "Advertising", robots: { index: false, follow: false } };

const STATE_TONE = { new: "cyan", draft: "mist", pending_approval: "gold", approved: "lime", scheduled: "cyan", live: "lime", paused: "gold", taken_down: "red" } as const;
const PAY_TONE = { unpaid: "gold", checkout_pending: "cyan", paid: "lime", failed: "red", refunded: "mist" } as const;
const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

type Campaign = {
  id: string; advertiser: string; name: string; status: string; payment_status: string;
  budget_cents: number | null; spent_cents: number; objective: string | null;
  starts_at: string | null; ends_at: string | null; advertiser_org_id: string | null;
  targeting: Record<string, unknown> | null; submitted_at: string | null; review_note: string | null;
};
type Creative = { id: string; campaign_id: string; kind: string; headline: string | null; body: string | null; status: string; review_note: string | null };
type Org = { id: string; name: string };
type RateCard = { id: string; placement: string; pricing_model: string; unit_price_cents: number; min_spend_cents: number; duration_days: number; active: boolean; note: string | null };
type Sponsor = { id: string; name: string; sponsor_name: string; status: string; credit_minutes: number; budget_cents: number | null; spent_cents: number; per_customer_minutes: number; starts_at: string; ends_at: string; review_note: string | null };
type Plan = { id: string; name: string; price_cents: number; interval: string; benefit: Record<string, number>; active: boolean; description: string | null };
type Inq = { id: string; company_name: string; contact_name: string; email: string; goals: string; budget: string | null; state: string; created_at: string };

const targetingSummary = (t: Record<string, unknown> | null) => {
  if (!t) return "All locations";
  const parts: string[] = [];
  for (const k of ["station_ids", "venue_ids", "cities", "venue_types"] as const) {
    const v = t[k];
    if (Array.isArray(v) && v.length) parts.push(`${k.replace("_ids", "").replace("_", " ")}: ${v.length}`);
  }
  return parts.length ? parts.join(" · ") : "All locations";
};

export default async function AdminAds({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const feedback = await searchParams;
  const db = serviceClient();
  const [inquiries, campaigns, creatives, orgs, rateCards, sponsors, plans] = db ? await Promise.all([
    db.from("advertising_inquiries").select("id,company_name,contact_name,email,goals,budget,state,created_at").order("created_at", { ascending: false }).limit(200),
    db.from("advertising_campaigns").select("id,advertiser,name,status,payment_status,budget_cents,spent_cents,objective,starts_at,ends_at,advertiser_org_id,targeting,schedule,submitted_at,review_note").order("created_at", { ascending: false }).limit(200),
    db.from("ad_creatives").select("id,campaign_id,kind,headline,body,status,review_note").order("created_at", { ascending: false }).limit(300),
    db.from("advertiser_orgs").select("id,name,status").order("created_at", { ascending: false }).limit(200),
    db.from("ad_rate_cards").select("id,placement,pricing_model,unit_price_cents,min_spend_cents,duration_days,active,note").order("created_at", { ascending: false }),
    db.from("sponsor_campaigns").select("id,name,sponsor_name,status,credit_minutes,budget_cents,spent_cents,per_customer_minutes,starts_at,ends_at,review_note").order("created_at", { ascending: false }).limit(100),
    db.from("membership_plans").select("id,name,price_cents,interval,benefit,active,description").order("created_at"),
  ]) : [null, null, null, null, null, null, null];

  const inqRows = (inquiries?.data ?? []) as unknown as Inq[];
  const campRows = (campaigns?.data ?? []) as unknown as Campaign[];
  const creativeRows = (creatives?.data ?? []) as unknown as Creative[];
  const orgRows = new Map(((orgs?.data ?? []) as unknown as Org[]).map((o) => [o.id, o.name]));
  const creativesByCampaign = new Map<string, Creative[]>();
  for (const c of creativeRows) {
    const list = creativesByCampaign.get(c.campaign_id) ?? [];
    list.push(c);
    creativesByCampaign.set(c.campaign_id, list);
  }
  const rateRows = (rateCards?.data ?? []) as unknown as RateCard[];
  const sponsorRows = (sponsors?.data ?? []) as unknown as Sponsor[];
  const planRows = (plans?.data ?? []) as unknown as Plan[];

  const advertiserName = (c: Campaign) => (c.advertiser_org_id && orgRows.get(c.advertiser_org_id)) || c.advertiser || "—";

  return (
    <AdminGate title="Advertising" nav="advertising">
      {!db ? (
        <EmptyCard title="Advertising data not connected">Connect Supabase to see live inquiries and campaigns.</EmptyCard>
      ) : (
        <div className="space-y-8">
          {feedback.result && <p role="status" className={`rounded-xl px-4 py-3 text-sm font-bold ${feedback.result === "saved" ? "bg-lime" : "bg-red-100 text-red-900"}`}>{feedback.result === "saved" ? "Saved." : "Could not save — check the values and try again."}</p>}

          <section aria-label="Advertising summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Metric label="Inquiries" value={inqRows.filter((i) => i.state === "new").length} sub={`${inqRows.length} total`} />
            <Metric label="Campaigns" value={campRows.length} sub={`${campRows.filter((c) => c.status === "live").length} live`} />
            <Metric label="Pending review" value={campRows.filter((c) => c.status === "pending_approval").length} />
            <Metric label="Ad revenue (paid campaigns)" value={fmt(campRows.filter((c) => c.payment_status === "paid").reduce((s, c) => s + (c.budget_cents ?? 0), 0))} sub="billed, not necessarily delivered" />
            <Metric label="Sponsors pending" value={sponsorRows.filter((s) => s.status === "pending").length} />
          </section>

          {/* ── Campaign review queue ─────────────────────────────── */}
          <section aria-label="Campaign review" className="space-y-4">
            <h2 className="font-display text-xl font-bold">Campaign review</h2>
            {campRows.filter((c) => c.status === "pending_approval" || c.status === "draft").length === 0 ? (
              <EmptyCard title="Nothing awaiting review">Campaigns submitted by advertisers appear here.</EmptyCard>
            ) : (
              campRows.filter((c) => c.status === "pending_approval" || c.status === "draft").map((c) => {
                const cr = creativesByCampaign.get(c.id) ?? [];
                const submitted = cr.filter((x) => x.status === "submitted");
                return (
                  <article key={c.id} className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h3 className="font-display text-lg font-bold">{c.name}</h3>
                        <p className="text-sm text-graphite">{advertiserName(c)}{c.objective ? ` · ${c.objective.replace(/_/g, " ")}` : ""}</p>
                        <p className="mt-1 text-xs text-graphite">
                          {c.budget_cents != null ? `${fmt(c.budget_cents)} budget · ` : ""}
                          {targetingSummary(c.targeting)} · submitted {when(c.submitted_at)}
                          {c.review_note ? ` · note: ${c.review_note}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Pill tone={c.status in STATE_TONE ? STATE_TONE[c.status as keyof typeof STATE_TONE] : "mist"}>{c.status.replace("_", " ")}</Pill>
                        <Pill tone={c.payment_status in PAY_TONE ? PAY_TONE[c.payment_status as keyof typeof PAY_TONE] : "mist"}>{c.payment_status.replace("_", " ")}</Pill>
                      </div>
                    </div>
                    {cr.length > 0 && (
                      <ul className="mt-4 space-y-2">
                        {cr.map((x) => (
                          <li key={x.id} className="flex items-center justify-between rounded-lg bg-mist/50 px-3 py-2 text-sm">
                            <span className="font-semibold">{x.headline ?? `${x.kind} creative`}</span>
                            <span className="flex items-center gap-2 text-xs text-graphite"><Pill tone={x.status === "approved" ? "lime" : x.status === "rejected" ? "red" : "gold"}>{x.status}</Pill>{x.review_note ? <span className="max-w-48 truncate">{x.review_note}</span> : null}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <form method="post" action="/api/admin/advertising" className="flex items-center gap-2">
                        <input type="hidden" name="action" value="campaign_review" /><input type="hidden" name="id" value={c.id} /><input type="hidden" name="decision" value="approve" />
                        <button className="min-h-9 rounded-full bg-lime px-4 text-xs font-bold hover:brightness-95" disabled={submitted.length === 0 && cr.every((x) => x.status === "draft")}>Approve{submitted.length ? ` (${submitted.length} creative${submitted.length > 1 ? "s" : ""})` : ""}</button>
                      </form>
                      <form method="post" action="/api/admin/advertising" className="flex items-center gap-2">
                        <input type="hidden" name="action" value="campaign_review" /><input type="hidden" name="id" value={c.id} /><input type="hidden" name="decision" value="reject" />
                        <input name="note" placeholder="Reason (optional)" className="min-h-9 rounded-lg border border-silver/60 px-2 text-xs" />
                        <button className="min-h-9 rounded-full bg-mist px-3 text-xs font-bold hover:bg-red-100">Reject</button>
                      </form>
                    </div>
                  </article>
                );
              })
            )}
          </section>

          {/* ── Live campaigns ────────────────────────────────────── */}
          <section aria-label="Campaigns" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">All campaigns</h2></div>
            {campRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No campaigns yet. Playback is only reported when a station confirms it.</p>
            ) : (
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Campaign", "Advertiser", "Status", "Payment", "Budget", "Runs", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {campRows.map((c) => (
                    <tr key={c.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{c.name}</td>
                      <td className="px-4 py-3 text-xs font-semibold">{advertiserName(c)}</td>
                      <td className="px-4 py-3"><Pill tone={c.status in STATE_TONE ? STATE_TONE[c.status as keyof typeof STATE_TONE] : "mist"}>{c.status.replace("_", " ")}</Pill></td>
                      <td className="px-4 py-3"><Pill tone={c.payment_status in PAY_TONE ? PAY_TONE[c.payment_status as keyof typeof PAY_TONE] : "mist"}>{c.payment_status.replace("_", " ")}</Pill></td>
                      <td className="px-4 py-3 text-xs">{c.budget_cents != null ? fmt(c.budget_cents) : "—"}{c.spent_cents ? <span className="text-graphite"> · {fmt(c.spent_cents)} spent</span> : null}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(c.starts_at)} → {when(c.ends_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {c.status === "approved" && <form method="post" action="/api/admin/advertising"><input type="hidden" name="action" value="campaign_status" /><input type="hidden" name="id" value={c.id} /><input type="hidden" name="status" value="scheduled" /><button className="min-h-8 rounded-full bg-mist px-2.5 text-[11px] font-bold">Schedule</button></form>}
                          {c.status === "scheduled" && <form method="post" action="/api/admin/advertising"><input type="hidden" name="action" value="campaign_status" /><input type="hidden" name="id" value={c.id} /><input type="hidden" name="status" value="live" /><button className="min-h-8 rounded-full bg-lime px-2.5 text-[11px] font-bold">Go live</button></form>}
                          {c.status === "live" && <form method="post" action="/api/admin/advertising"><input type="hidden" name="action" value="campaign_status" /><input type="hidden" name="id" value={c.id} /><input type="hidden" name="status" value="paused" /><button className="min-h-8 rounded-full bg-mist px-2.5 text-[11px] font-bold">Pause</button></form>}
                          {c.status === "paused" && <form method="post" action="/api/admin/advertising"><input type="hidden" name="action" value="campaign_status" /><input type="hidden" name="id" value={c.id} /><input type="hidden" name="status" value="live" /><button className="min-h-8 rounded-full bg-lime px-2.5 text-[11px] font-bold">Resume</button></form>}
                          {(c.status === "live" || c.status === "scheduled" || c.status === "paused") && <form method="post" action="/api/admin/advertising"><input type="hidden" name="action" value="campaign_review" /><input type="hidden" name="id" value={c.id} /><input type="hidden" name="decision" value="taken_down" /><button className="min-h-8 rounded-full bg-red-100 px-2.5 text-[11px] font-bold text-red-900">Take down</button></form>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ── Rate cards ────────────────────────────────────────── */}
          <section aria-label="Rate cards" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-lg font-bold">Rate cards</h2>
              <form method="post" action="/api/admin/advertising" className="flex flex-wrap items-center gap-2 text-xs">
                <input type="hidden" name="action" value="rate_card_create" />
                <select name="placement" className="min-h-9 rounded-lg border border-silver/60 px-2 font-semibold" aria-label="Placement">
                  <option value="kiosk_screen">Kiosk screen</option><option value="website">Website</option><option value="email">Email</option><option value="event">Event</option>
                </select>
                <select name="pricing_model" className="min-h-9 rounded-lg border border-silver/60 px-2 font-semibold" aria-label="Pricing model">
                  <option value="fixed">Fixed</option><option value="cpm">CPM</option><option value="cpc">CPC</option>
                </select>
                <input name="unit_price_cents" type="number" min="0" step="1" placeholder="Price ¢" required className="min-h-9 w-24 rounded-lg border border-silver/60 px-2" aria-label="Unit price cents" />
                <input name="min_spend_cents" type="number" min="0" step="1" placeholder="Min spend ¢" className="min-h-9 w-24 rounded-lg border border-silver/60 px-2" aria-label="Minimum spend cents" />
                <input name="duration_days" type="number" min="1" max="365" placeholder="Days" className="min-h-9 w-16 rounded-lg border border-silver/60 px-2" aria-label="Duration days" />
                <input name="note" placeholder="Note" className="min-h-9 w-36 rounded-lg border border-silver/60 px-2" aria-label="Note" />
                <button className="min-h-9 rounded-full bg-mist px-3 font-bold hover:bg-lime">Add rate</button>
              </form>
            </div>
            {rateRows.length === 0 ? (
              <p className="px-6 py-8 text-sm text-graphite">No rate cards yet. Advertisers see “contact us” pricing until rates are published here.</p>
            ) : (
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Placement", "Model", "Unit price", "Min spend", "Duration", "Status", "Note"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rateRows.map((r) => (
                    <tr key={r.id} className="border-b border-mist/70 last:border-0">
                      <td className="px-4 py-3 font-semibold">{r.placement.replace("_", " ")}</td>
                      <td className="px-4 py-3 text-xs uppercase">{r.pricing_model}</td>
                      <td className="px-4 py-3">{fmt(r.unit_price_cents)}{r.pricing_model === "fixed" ? "/day" : r.pricing_model === "cpm" ? "/1k" : "/click"}</td>
                      <td className="px-4 py-3 text-xs">{fmt(r.min_spend_cents)}</td>
                      <td className="px-4 py-3 text-xs">{r.duration_days}d</td>
                      <td className="px-4 py-3"><Pill tone={r.active ? "lime" : "mist"}>{r.active ? "active" : "inactive"}</Pill></td>
                      <td className="px-4 py-3 text-xs text-graphite">{r.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ── Sponsored charging ────────────────────────────────── */}
          <section aria-label="Sponsored charging" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Sponsored charging</h2></div>
            {sponsorRows.length === 0 ? (
              <p className="px-6 py-8 text-sm text-graphite">No sponsorships yet. Venue-funded charging credits submitted by partners appear here for approval.</p>
            ) : (
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Campaign", "Sponsor", "Credit", "Budget", "Per customer", "Window", "Status", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {sponsorRows.map((s) => (
                    <tr key={s.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{s.name}</td>
                      <td className="px-4 py-3 text-xs font-semibold">{s.sponsor_name}</td>
                      <td className="px-4 py-3 text-xs">{s.credit_minutes} min</td>
                      <td className="px-4 py-3 text-xs">{s.budget_cents != null ? fmt(s.budget_cents) : "—"}{s.spent_cents ? ` · ${fmt(s.spent_cents)} spent` : ""}</td>
                      <td className="px-4 py-3 text-xs">{s.per_customer_minutes} min</td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(s.starts_at)} → {when(s.ends_at)}</td>
                      <td className="px-4 py-3"><Pill tone={s.status === "active" ? "lime" : s.status === "pending" ? "gold" : s.status === "rejected" ? "red" : "mist"}>{s.status}</Pill></td>
                      <td className="px-4 py-3">
                        {s.status === "pending" && (
                          <div className="flex gap-1">
                            <form method="post" action="/api/admin/advertising"><input type="hidden" name="action" value="sponsor_review" /><input type="hidden" name="id" value={s.id} /><input type="hidden" name="decision" value="approve" /><button className="min-h-8 rounded-full bg-lime px-2.5 text-[11px] font-bold">Approve</button></form>
                            <form method="post" action="/api/admin/advertising"><input type="hidden" name="action" value="sponsor_review" /><input type="hidden" name="id" value={s.id} /><input type="hidden" name="decision" value="reject" /><button className="min-h-8 rounded-full bg-red-100 px-2.5 text-[11px] font-bold text-red-900">Reject</button></form>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ── Membership plans ──────────────────────────────────── */}
          <section aria-label="Membership plans" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-lg font-bold">Membership plans</h2>
              <form method="post" action="/api/admin/advertising" className="flex flex-wrap items-center gap-2 text-xs">
                <input type="hidden" name="action" value="plan_create" />
                <input name="id" placeholder="plan-id" required pattern="[a-z0-9][a-z0-9-]+" className="min-h-9 w-28 rounded-lg border border-silver/60 px-2" aria-label="Plan id" />
                <input name="name" placeholder="Name" required className="min-h-9 w-32 rounded-lg border border-silver/60 px-2" aria-label="Plan name" />
                <input name="price_cents" type="number" min="0" placeholder="Price ¢" required className="min-h-9 w-24 rounded-lg border border-silver/60 px-2" aria-label="Price cents" />
                <select name="interval" className="min-h-9 rounded-lg border border-silver/60 px-2 font-semibold" aria-label="Interval">
                  <option value="one_time">One-time</option><option value="month">Monthly</option><option value="year">Yearly</option>
                </select>
                <input name="benefit_rental_minutes" type="number" min="0" placeholder="Minutes" className="min-h-9 w-20 rounded-lg border border-silver/60 px-2" aria-label="Rental minutes benefit" />
                <input name="benefit_rentals" type="number" min="0" placeholder="Rentals" className="min-h-9 w-20 rounded-lg border border-silver/60 px-2" aria-label="Rentals benefit" />
                <label className="flex items-center gap-1 font-semibold"><input type="checkbox" name="active" value="on" /> active</label>
                <button className="min-h-9 rounded-full bg-mist px-3 font-bold hover:bg-lime">Add plan</button>
              </form>
            </div>
            {planRows.length === 0 ? (
              <p className="px-6 py-8 text-sm text-graphite">No membership plans yet. Plans stay hidden from customers until activated.</p>
            ) : (
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Plan", "Price", "Interval", "Benefit", "Status", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {planRows.map((p) => (
                    <tr key={p.id} className="border-b border-mist/70 last:border-0">
                      <td className="px-4 py-3"><p className="font-bold">{p.name}</p><p className="text-xs text-graphite">{p.id}</p></td>
                      <td className="px-4 py-3">{fmt(p.price_cents)}</td>
                      <td className="px-4 py-3 text-xs">{p.interval}</td>
                      <td className="px-4 py-3 text-xs">{p.benefit.rental_minutes ? `${p.benefit.rental_minutes} min` : ""}{p.benefit.rental_minutes && p.benefit.rentals ? " + " : ""}{p.benefit.rentals ? `${p.benefit.rentals} rentals` : ""}</td>
                      <td className="px-4 py-3"><Pill tone={p.active ? "lime" : "mist"}>{p.active ? "active" : "draft"}</Pill></td>
                      <td className="px-4 py-3">
                        <form method="post" action="/api/admin/advertising">
                          <input type="hidden" name="action" value="plan_toggle" /><input type="hidden" name="id" value={p.id} /><input type="hidden" name="active" value={p.active ? "off" : "on"} />
                          <button className="min-h-8 rounded-full bg-mist px-2.5 text-[11px] font-bold">{p.active ? "Deactivate" : "Activate"}</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ── Inquiries (existing) ──────────────────────────────── */}
          <section aria-label="Inquiries" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Inquiries</h2></div>
            {inqRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No inquiries yet. Advertising inquiries submitted via /advertise appear here.</p>
            ) : (
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Company", "Contact", "Goals", "Budget", "State", "Received"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {inqRows.map((i) => (
                    <tr key={i.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{i.company_name}</td>
                      <td className="px-4 py-3"><p className="font-semibold">{i.contact_name}</p><p className="text-xs text-graphite">{i.email}</p></td>
                      <td className="max-w-xs px-4 py-3"><p className="truncate text-xs text-graphite">{i.goals}</p></td>
                      <td className="px-4 py-3 text-xs font-semibold">{i.budget ?? "—"}</td>
                      <td className="px-4 py-3"><form method="post" action="/api/admin/advertising" className="flex items-center gap-2"><input type="hidden" name="action" value="inquiry_state" /><input type="hidden" name="id" value={i.id} /><select name="state" defaultValue={i.state} aria-label={`Inquiry status for ${i.company_name}`} className="min-h-9 rounded-lg border border-silver/60 px-2 text-xs font-semibold">{["new", "reviewing", "closed"].map((s) => <option key={s} value={s}>{s}</option>)}</select><button className="min-h-9 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Save</button></form></td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(i.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </AdminGate>
  );
}
