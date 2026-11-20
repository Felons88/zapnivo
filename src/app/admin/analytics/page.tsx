export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { Metric } from "@/components/PortalShell";
import { loadAdminInsights, JOURNEY_FUNNEL } from "@/lib/admin-insights";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Analytics", robots: { index: false, follow: false } };

const DAYS = 30;
const EVENT_LABELS: Record<string, string> = {
  page_view: "Page views", session_start: "Sessions", view_business_page: "Business page views",
  view_station_locations: "Station locator views", click_partner_cta: "Partner CTA clicks",
  click_find_station: "Find-a-station clicks", click_contact: "Contact clicks", view_pricing: "Pricing views",
  partner_application_started: "Partner apps started", partner_application_step: "App steps",
  partner_application_submitted: "Partner apps submitted", partner_application_approved: "Partner apps approved",
  rental_qr_opened: "QR scans", rental_checkout_started: "Checkouts started", rental_terms_accepted: "Terms accepted",
  rental_payment_started: "Payments started", rental_payment_failed: "Payments failed",
  rental_started: "Rentals started", rental_completed: "Rentals completed", rental_refunded: "Refunds",
  rental_return_problem: "Return problems", support_chat_opened: "Chat opens", support_question_submitted: "Chat questions",
  support_auth_requested: "Auth requests", support_otp_requested: "OTP requests", support_otp_verified: "OTP verified",
  support_ticket_created: "Tickets created", support_ai_resolved: "AI resolutions", support_human_escalated: "Human escalations",
  customer_return_visit: "Return visits", customer_feedback_submitted: "Feedback",
};

type Ev = { name: string; props: Record<string, unknown> | null; occurred_at: string; source: string };

export default async function Analytics() {
  const db = serviceClient();
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data } = db
    ? await db.from("business_events").select("name,props,occurred_at,source").gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(20000)
    : { data: null };
  const events = (data ?? []) as Ev[];

  const byName = new Map<string, number>();
  const byDay = new Map<string, number>();
  const byPath = new Map<string, number>();
  for (const e of events) {
    byName.set(e.name, (byName.get(e.name) ?? 0) + 1);
    byDay.set(e.occurred_at.slice(0, 10), (byDay.get(e.occurred_at.slice(0, 10)) ?? 0) + 1);
    const p = typeof e.props?.path === "string" ? e.props.path : null;
    if (p) byPath.set(p, (byPath.get(p) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n = 12) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const funnel = ["partner_application_started", "partner_application_step", "partner_application_submitted", "partner_application_approved"]
    .map((n) => ({ name: n, count: byName.get(n) ?? 0 }));
  const rentalFunnel = ["rental_checkout_started", "rental_payment_started", "rental_started", "rental_completed"]
    .map((n) => ({ name: n, count: byName.get(n) ?? 0 }));
  const days = [...byDay.entries()].sort().slice(-14);
  const maxDay = Math.max(1, ...days.map(([, c]) => c));

  // Phase 5 BI sections — each degrades to null independently on query failure.
  const insights = db ? await loadAdminInsights(db, events) : null;
  const money = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const cohortRows = insights?.cohorts ?? null;
  const stationRows = insights?.stations ?? null;
  const topStations = stationRows?.slice(0, 10) ?? null;
  const bottomStations = stationRows?.filter((s) => s.bottomDecile) ?? null;
  const journey = insights?.funnel ?? JOURNEY_FUNNEL.map((f) => ({ name: f.name, label: f.label, count: byName.get(f.name) ?? 0, convPct: null }));
  // Merge the two weekly series onto a shared week axis (last 10 weeks shown).
  const weekSet = new Set<string>();
  for (const w of insights?.exceptionsWeekly ?? []) weekSet.add(w.week);
  for (const w of insights?.ticketsWeekly ?? []) weekSet.add(w.week);
  const weeks = [...weekSet].sort().slice(-10);
  const exByWeek = new Map((insights?.exceptionsWeekly ?? []).map((w) => [w.week, w.count]));
  const tkByWeek = new Map((insights?.ticketsWeekly ?? []).map((w) => [w.week, w.count]));
  const maxWeek = Math.max(1, ...weeks.map((w) => Math.max(exByWeek.get(w) ?? 0, tkByWeek.get(w) ?? 0)));

  return (
    <AdminGate title="Analytics" nav="analytics">
      <div className="space-y-4">
        <p className="text-sm text-graphite">First-party events, last {DAYS} days · {events.length.toLocaleString()} recorded. GA4 runs in parallel when configured — this is the authoritative store. <a href="/admin/forecasting" className="font-bold text-forest underline">Demand forecasting →</a></p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Events" value={events.length} />
          <Metric label="Page views" value={byName.get("page_view") ?? 0} />
          <Metric label="Sessions" value={byName.get("session_start") ?? 0} />
          <Metric label="Partner apps" value={byName.get("partner_application_submitted") ?? 0} />
        </div>

        <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4">
          <h2 className="text-lg font-bold">Events by type</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[#e3e8ee] text-left text-xs uppercase tracking-wider text-graphite"><th className="py-2 pr-4">Event</th><th className="py-2 pr-4">Count</th><th className="py-2">Source</th></tr></thead>
              <tbody>
                {top(byName, 25).map(([name, count]) => {
                  const src = events.find((e) => e.name === name)?.source ?? "—";
                  return <tr key={name} className="border-b border-[#e3e8ee]/60"><td className="py-2 pr-4 font-semibold">{EVENT_LABELS[name] ?? name}</td><td className="py-2 pr-4">{count.toLocaleString()}</td><td className="py-2 text-graphite">{src}</td></tr>;
                })}
                {events.length === 0 && <tr><td colSpan={3} className="py-6 text-center text-graphite">No events yet — the pipeline activates as visitors interact (consent-gated).</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4">
            <h2 className="text-lg font-bold">Events per day</h2>
            <div className="mt-4 flex h-32 items-end gap-1">
              {days.map(([d, c]) => (
                <div key={d} className="group relative flex-1" title={`${d}: ${c}`}>
                  <div className="w-full rounded-t bg-[#edeeff] transition group-hover:bg-[#edeeff]" style={{ height: `${Math.max(4, (c / maxDay) * 100)}%` }} />
                </div>
              ))}
              {days.length === 0 && <p className="text-sm text-graphite">No data yet.</p>}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-graphite"><span>{days[0]?.[0] ?? ""}</span><span>{days[days.length - 1]?.[0] ?? ""}</span></div>
          </section>

          <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4">
            <h2 className="text-lg font-bold">Top pages</h2>
            <ul className="mt-3 space-y-1 text-sm">
              {top(byPath, 10).map(([p, c]) => <li key={p} className="flex justify-between gap-3"><span className="truncate font-mono text-xs">{p}</span><span className="font-bold">{c}</span></li>)}
              {byPath.size === 0 && <li className="text-graphite">No page data yet.</li>}
            </ul>
          </section>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4">
            <h2 className="text-lg font-bold">Partner acquisition funnel</h2>
            <ol className="mt-4 space-y-2">
              {funnel.map((f, i) => {
                const prev = i === 0 ? null : funnel[i - 1].count;
                const conv = prev && prev > 0 ? Math.round((f.count / prev) * 100) : null;
                return (
                  <li key={f.name} className="flex items-center justify-between rounded-lg bg-paper px-4 py-2 text-sm">
                    <span className="font-semibold">{EVENT_LABELS[f.name] ?? f.name}</span>
                    <span className="font-bold">{f.count}{conv !== null && <span className="ml-2 text-xs font-semibold text-graphite">{conv}%</span>}</span>
                  </li>
                );
              })}
            </ol>
          </section>
          <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4">
            <h2 className="text-lg font-bold">Rental funnel</h2>
            <ol className="mt-4 space-y-2">
              {rentalFunnel.map((f, i) => {
                const prev = i === 0 ? null : rentalFunnel[i - 1].count;
                const conv = prev && prev > 0 ? Math.round((f.count / prev) * 100) : null;
                return (
                  <li key={f.name} className="flex items-center justify-between rounded-lg bg-paper px-4 py-2 text-sm">
                    <span className="font-semibold">{EVENT_LABELS[f.name] ?? f.name}</span>
                    <span className="font-bold">{f.count}{conv !== null && <span className="ml-2 text-xs font-semibold text-graphite">{conv}%</span>}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        {/* ── Phase 5: BI depth ─────────────────────────────────────────── */}
        <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4">
          <h2 className="text-lg font-bold">Customer journey funnel</h2>
          <p className="mt-1 text-xs text-graphite">Source: business_events (last {DAYS} days). Terminal step is feedback — there is no dedicated review event in the pipeline.</p>
          <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {journey.map((f, i) => {
              const conv = f.convPct;
              return (
                <li key={f.name} className="flex items-center justify-between rounded-lg bg-paper px-4 py-2 text-sm">
                  <span className="font-semibold">{f.label}</span>
                  <span className="font-bold">{f.count}{conv !== null && <span className="ml-2 text-xs font-semibold text-graphite">{conv}%</span>}</span>
                </li>
              );
            })}
          </ol>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4">
            <h2 className="text-lg font-bold">Cohort retention snapshot</h2>
            <p className="mt-1 text-xs text-graphite">Source: analytics_cohorts. Week-2/4 = share of a cohort still seen ≥7/≥28 days after first event; immature cohorts show — until they mature.</p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[#e3e8ee] text-left text-xs uppercase tracking-wider text-graphite"><th className="py-2 pr-4">Cohort week</th><th className="py-2 pr-4">Subjects</th><th className="py-2 pr-4">Wk-2 retained</th><th className="py-2 pr-4">Wk-4 retained</th><th className="py-2">Avg active days</th></tr></thead>
                <tbody>
                  {(cohortRows ?? []).slice(-8).reverse().map((c) => (
                    <tr key={c.weekStart} className="border-b border-[#e3e8ee]/60">
                      <td className="py-2 pr-4 font-semibold">{c.weekStart}</td>
                      <td className="py-2 pr-4">{c.subjects}</td>
                      <td className="py-2 pr-4">{c.week2Pct === null ? "—" : `${c.week2Pct}%`}{c.matured2 < c.subjects && <span className="ml-1 text-[10px] text-graphite">({c.matured2} matured)</span>}</td>
                      <td className="py-2 pr-4">{c.week4Pct === null ? "—" : `${c.week4Pct}%`}{c.matured4 < c.subjects && <span className="ml-1 text-[10px] text-graphite">({c.matured4} matured)</span>}</td>
                      <td className="py-2">{c.avgDaysActive}</td>
                    </tr>
                  ))}
                  {cohortRows != null && cohortRows.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-graphite">No cohort data yet — populated by the daily analytics aggregation.</td></tr>}
                  {cohortRows === null && <tr><td colSpan={5} className="py-6 text-center text-graphite">Cohort data unavailable.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4">
            <h2 className="text-lg font-bold">Station revenue &amp; utilization</h2>
            <p className="mt-1 text-xs text-graphite">Source: rentals ⋈ payments ⋈ kiosks ⋈ venues. Gross = captured − refunded; completion = rentals reaching 'returned'. Bottom-decile stations (lowest gross, ≥5 stations) are flagged.</p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[#e3e8ee] text-left text-xs uppercase tracking-wider text-graphite"><th className="py-2 pr-4">Station</th><th className="py-2 pr-4">Venue</th><th className="py-2 pr-4">Rentals</th><th className="py-2 pr-4">Gross</th><th className="py-2 pr-4">Returned</th><th className="py-2">Completion</th></tr></thead>
                <tbody>
                  {(topStations ?? []).map((s) => (
                    <tr key={s.station} className={`border-b border-[#e3e8ee]/60 ${s.bottomDecile ? "bg-red-50" : ""}`}>
                      <td className="py-2 pr-4 font-semibold">{s.station}{s.bottomDecile && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700">low</span>}</td>
                      <td className="py-2 pr-4 text-graphite">{s.venue ?? "—"}</td>
                      <td className="py-2 pr-4">{s.rentals}</td>
                      <td className="py-2 pr-4 font-bold">{money(s.grossCents)}</td>
                      <td className="py-2 pr-4">{s.returned}</td>
                      <td className="py-2">{s.completionPct === null ? "—" : `${s.completionPct}%`}</td>
                    </tr>
                  ))}
                  {stationRows != null && stationRows.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-graphite">No rentals recorded yet.</td></tr>}
                  {stationRows === null && <tr><td colSpan={6} className="py-6 text-center text-graphite">Station data unavailable.</td></tr>}
                </tbody>
              </table>
            </div>
            {bottomStations != null && bottomStations.length > 0 && (
              <p className="mt-3 text-xs text-graphite">Bottom-decile stations by gross: {bottomStations.map((s) => s.station).join(", ")}</p>
            )}
          </section>
        </div>

        <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-bold">Exceptions &amp; support volume by week</h2>
            <p className="text-xs text-graphite">Sources: rental_exceptions.created_at · support_tickets.created_at</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <Metric label="Open exceptions" value={insights?.openExceptions ?? "—"} />
            <Metric label="Open tickets" value={insights?.openTickets ?? "—"} />
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[#e3e8ee] text-left text-xs uppercase tracking-wider text-graphite"><th className="py-2 pr-4">Week of</th><th className="py-2 pr-4">Exceptions</th><th className="py-2 pr-4">Tickets</th><th className="py-2">Trend</th></tr></thead>
              <tbody>
                {weeks.map((w) => {
                  const ex = exByWeek.get(w) ?? 0;
                  const tk = tkByWeek.get(w) ?? 0;
                  const total = ex + tk;
                  return (
                    <tr key={w} className="border-b border-[#e3e8ee]/60">
                      <td className="py-2 pr-4 font-semibold">{w}</td>
                      <td className="py-2 pr-4">{ex}</td>
                      <td className="py-2 pr-4">{tk}</td>
                      <td className="py-2">
                        <div className="h-2 w-40 rounded bg-paper"><div className="h-2 rounded bg-[#edeeff]" style={{ width: `${Math.max(2, (total / maxWeek) * 100)}%` }} /></div>
                      </td>
                    </tr>
                  );
                })}
                {weeks.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-graphite">No exceptions or tickets recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AdminGate>
  );
}
