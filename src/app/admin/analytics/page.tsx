export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { Metric } from "@/components/PortalShell";
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

  return (
    <AdminGate title="Analytics" nav="analytics">
      <div className="space-y-8">
        <p className="text-sm text-graphite">First-party events, last {DAYS} days · {events.length.toLocaleString()} recorded. GA4 runs in parallel when configured — this is the authoritative store.</p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Events" value={events.length} />
          <Metric label="Page views" value={byName.get("page_view") ?? 0} />
          <Metric label="Sessions" value={byName.get("session_start") ?? 0} />
          <Metric label="Partner apps" value={byName.get("partner_application_submitted") ?? 0} />
        </div>

        <section className="rounded-2xl border border-mist bg-white p-6">
          <h2 className="text-lg font-bold">Events by type</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite"><th className="py-2 pr-4">Event</th><th className="py-2 pr-4">Count</th><th className="py-2">Source</th></tr></thead>
              <tbody>
                {top(byName, 25).map(([name, count]) => {
                  const src = events.find((e) => e.name === name)?.source ?? "—";
                  return <tr key={name} className="border-b border-mist/60"><td className="py-2 pr-4 font-semibold">{EVENT_LABELS[name] ?? name}</td><td className="py-2 pr-4">{count.toLocaleString()}</td><td className="py-2 text-graphite">{src}</td></tr>;
                })}
                {events.length === 0 && <tr><td colSpan={3} className="py-6 text-center text-graphite">No events yet — the pipeline activates as visitors interact (consent-gated).</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-mist bg-white p-6">
            <h2 className="text-lg font-bold">Events per day</h2>
            <div className="mt-4 flex h-32 items-end gap-1">
              {days.map(([d, c]) => (
                <div key={d} className="group relative flex-1" title={`${d}: ${c}`}>
                  <div className="w-full rounded-t bg-lime/80 transition group-hover:bg-lime" style={{ height: `${Math.max(4, (c / maxDay) * 100)}%` }} />
                </div>
              ))}
              {days.length === 0 && <p className="text-sm text-graphite">No data yet.</p>}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-graphite"><span>{days[0]?.[0] ?? ""}</span><span>{days[days.length - 1]?.[0] ?? ""}</span></div>
          </section>

          <section className="rounded-2xl border border-mist bg-white p-6">
            <h2 className="text-lg font-bold">Top pages</h2>
            <ul className="mt-3 space-y-1 text-sm">
              {top(byPath, 10).map(([p, c]) => <li key={p} className="flex justify-between gap-3"><span className="truncate font-mono text-xs">{p}</span><span className="font-bold">{c}</span></li>)}
              {byPath.size === 0 && <li className="text-graphite">No page data yet.</li>}
            </ul>
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-mist bg-white p-6">
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
          <section className="rounded-2xl border border-mist bg-white p-6">
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
      </div>
    </AdminGate>
  );
}
