export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { getAdminStats, pick, total } from "@/lib/admin-stats";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { slaStatus } from "@/lib/helpdesk/sla";
import type { Ticket } from "@/lib/helpdesk/types";
import { loadAdminInsights } from "@/lib/admin-insights";
import { serviceClient } from "@/lib/supabase";
import { fetchFinanceData, periodWindow, computeSummary } from "@/lib/admin-finance";
import { fmt } from "@/lib/pricing";
import TrendChart from "@/components/TrendChart";
import { FunnelChart, LeaderboardChart } from "@/components/Charts";

export const metadata: Metadata = { title: "Operations overview", robots: { index: false, follow: false } };

// ── Stripe-style tokens ──────────────────────────────────────────────────────
const card = "rounded-xl border border-[#e3e8ee] bg-white shadow-[0_1px_3px_rgba(10,37,64,.05)]";
const navy = "text-[#0a2540]";
const secondary = "text-[#425466]";
const muted = "text-[#8898aa]";
const accent = "text-[#635bff]";

const ACTIONS = [
  { title: "Resolve a customer issue", desc: "Work the inbox and reply from the case", href: "/admin/support?view=person" },
  { title: "Find a customer", desc: "Search by name, phone, or reference", href: "/admin/customers" },
  { title: "Check a station", desc: "Review devices that are offline or stale", href: "/admin/fleet?state=attention" },
  { title: "Review the money", desc: "Payouts, refunds, and disputes", href: "/admin/finance" },
] as const;

function StatCard({ label, value, hint, href, alert = false }: { label: string; value: string; hint: string; href: string; alert?: boolean }) {
  return (
    <Link href={href} className={`group block p-4 ${card} transition hover:border-[#c7cfda]`}>
      <span className="flex items-center gap-1.5 text-[13px] font-medium text-[#425466]">
        {alert ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#df1b41]" /> : null}
        {label}
      </span>
      <span className={`mt-1 block text-[26px] font-semibold leading-8 tracking-tight tabular-nums ${alert ? "text-[#df1b41]" : navy}`}>{value}</span>
      <span className={`mt-1 block text-xs ${muted}`}>{hint} <span className={`${accent} opacity-0 transition group-hover:opacity-100`}>→</span></span>
    </Link>
  );
}

function ModuleHeading({ title, href, action }: { title: string; href?: string; action?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#e3e8ee] px-4 py-3">
      <h2 className={`text-[13px] font-semibold ${navy}`}>{title}</h2>
      {href ? <Link href={href} className={`text-xs font-medium ${accent} hover:text-[#0a2540]`}>{action ?? "View all"} →</Link> : null}
    </div>
  );
}

function MetricRow({ label, value, href, alert = false }: { label: string; value: string; href: string; alert?: boolean }) {
  return (
    <Link href={href} className="flex items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-[#f6f9fc]">
      <span className="flex items-center gap-2 text-[13px] text-[#425466]">
        {alert ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#df1b41]" /> : null}
        {label}
      </span>
      <span className={`text-[13px] font-semibold tabular-nums ${alert ? "text-[#df1b41]" : navy}`}>{value}</span>
    </Link>
  );
}

function StatePill({ state }: { state: string }) {
  const tone =
    state === "resolved" || state === "closed" ? "bg-[#e6f5ef] text-[#0e6245]"
    : state === "open" || state === "needs_human" ? "bg-[#fff3d6] text-[#b25e09]"
    : "bg-[#e3e8ee] text-[#425466]";
  return <span className={`hidden rounded-full px-2 py-0.5 text-[11px] font-medium capitalize sm:block ${tone}`}>{state.replace(/_/g, " ")}</span>;
}

export default async function AdminDashboard() {
  const [ctx, stats] = await Promise.all([defaultCtx(), getAdminStats()]);

  const [metrics, tickets] = ctx
    ? await Promise.all([computeMetrics(ctx.repo), ctx.repo.listTickets({ limit: 250 })])
    : [null, [] as Ticket[]];

  const db = serviceClient();
  const financeWindow = periodWindow(30);
  const financeData = db ? await fetchFinanceData(db, financeWindow) : null;
  const financeSummary = financeData ? computeSummary(financeData, financeWindow) : null;

  const events = db
    ? (await db.from("business_events").select("name,occurred_at").gte("occurred_at", financeWindow.start).limit(20000)).data ?? []
    : [];
  const insights = db ? await loadAdminInsights(db, events as { name: string }[]) : null;

  const now = new Date();
  const attention = tickets.filter(
    (t: Ticket) =>
      t.state !== "resolved" &&
      t.state !== "closed" &&
      t.aiState !== "ai_active" &&
      (t.priority === "urgent" || !t.assignedTo || slaStatus(t, now).firstResponse === "breached"),
  );
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  attention.sort((a: Ticket, b: Ticket) => rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt));
  const queue = attention.slice(0, 6);

  const fleetAttention = stats?.kioskStates == null ? null : pick(stats.kioskStates, "offline") + pick(stats.kioskStates, "stale");
  const stationOnline = stats?.kioskStates == null ? null : `${pick(stats.kioskStates, "online")} / ${total(stats.kioskStates)}`;
  const slotsReady = stats?.slotStates == null ? null : `${pick(stats.slotStates, "ready")} / ${total(stats.slotStates)}`;
  const activeRentals = stats?.rentalStates == null ? null : pick(stats.rentalStates, "active") + pick(stats.rentalStates, "dispense_pending");
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);

  const funnelSteps = (insights?.funnel ?? []).map((f) => ({ label: f.label, count: f.count, convPct: f.convPct }));
  const leaderboardRows =
    (insights?.stations ?? []).slice(0, 10).map((s) => ({
      label: s.station,
      detail: s.venue ?? undefined,
      value: s.grossCents / 100,
      flag: s.bottomDecile ? "bottom decile" : undefined,
    })) ?? [];

  const rentalsByDay = stats?.rentalsByDay ?? {};
  const days = Object.keys(rentalsByDay).sort();
  const series = [
    { label: "Rentals started", color: "#635bff", data: days.map((d) => rentalsByDay[d] ?? 0) },
    { label: "Support tickets", color: "#80b9ff", data: days.map((d) => tickets.filter((t: Ticket) => t.createdAt.slice(0, 10) === d).length) },
  ];

  const num = (v: number | null | undefined) => (v == null ? "—" : String(v));
  const money = (v: number | null | undefined) => (v == null ? "—" : fmt(v));
  const refundsAwaiting = metrics?.refunds.requested ?? null;
  const disputesOpen = stats?.disputesOpen ?? null;

  return (
    <AdminGate title="Operations overview" nav="dashboard">
      <div className="-mx-5 -my-5 min-h-[calc(100vh-8rem)] bg-[#f6f9fc] px-5 py-6 md:-mx-8 md:px-8">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <h1 className={`text-xl font-bold tracking-tight ${navy}`}>Your operations overview</h1>
            <p className={`mt-0.5 text-sm ${secondary}`}>{today}</p>
          </div>
          <form method="get" action="/admin/search" className="flex min-w-0 flex-1 gap-2 lg:max-w-md">
            <input name="q" required minLength={2} aria-label="Search the workspace" placeholder="Search customers, tickets, rentals…" className={`min-h-10 min-w-0 flex-1 rounded-lg border border-[#e3e8ee] bg-white px-3 text-sm ${navy} shadow-[0_1px_2px_rgba(10,37,64,.04)] outline-none placeholder:text-[#8898aa] focus:border-[#635bff]`} />
            <button className="rounded-lg bg-[#635bff] px-4 text-sm font-semibold text-white transition hover:bg-[#5851ea]">Search</button>
          </form>
          <Link href="/admin/support?view=person" className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-[#e3e8ee] bg-white px-4 text-sm font-semibold ${navy} shadow-[0_1px_2px_rgba(10,37,64,.04)] transition hover:border-[#c7cfda]`}>
            Priority queue{metrics ? ` (${metrics.needsHuman})` : ""}
          </Link>
        </div>

        {/* ── Top stats ──────────────────────────────────────────────── */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Needs a person" value={num(metrics?.needsHuman)} hint="Cases waiting on staff" href="/admin/support?view=person" alert={(metrics?.needsHuman ?? 0) > 0} />
          <StatCard label="Fleet attention" value={num(fleetAttention)} hint="Offline or stale stations" href="/admin/fleet?state=attention" alert={(fleetAttention ?? 0) > 0} />
          <StatCard label="Active rentals" value={num(activeRentals)} hint="Renting or dispensing now" href="/admin/rentals" />
          <StatCard label="Captured today" value={money(stats?.revenueTodayCents)} hint="Successful payments only" href="/admin/finance" />
        </div>

        {/* ── Main grid: work surface + side modules ─────────────────── */}
        <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            {/* Needs attention */}
            <section aria-labelledby="attention-title" className={`overflow-hidden ${card}`}>
              <ModuleHeading title="Needs attention" href="/admin/support?view=person" action="Open inbox" />
              {!ctx ? (
                <p className={`px-4 py-10 text-center text-sm ${secondary}`}>Support data is unavailable in this environment.</p>
              ) : queue.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className={`text-sm font-semibold ${navy}`}>You're all caught up</p>
                  <p className={`mt-1 text-xs ${muted}`}>Urgent, unassigned, or SLA-breached cases appear here.</p>
                </div>
              ) : (
                <ul className="divide-y divide-[#eef1f5]">
                  {queue.map((t) => (
                    <li key={t.id}>
                      <Link href={`/admin/support/${t.number}`} className="group flex items-center gap-3 px-4 py-3 transition hover:bg-[#f6f9fc]">
                        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#e3e8ee] text-xs font-bold ${navy}`}>
                          {(t.name || "?").slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={`truncate text-sm font-semibold ${navy}`}>{t.subject || t.category}</span>
                            {t.priority === "urgent" ? (
                              <span className="rounded-full bg-[#ffe2e5] px-2 py-0.5 text-[10px] font-semibold text-[#df1b41]">urgent</span>
                            ) : t.priority === "high" ? (
                              <span className="rounded-full bg-[#fff3d6] px-2 py-0.5 text-[10px] font-semibold text-[#b25e09]">high</span>
                            ) : null}
                          </span>
                          <span className={`mt-0.5 block truncate text-xs ${muted}`}>{t.number} · {t.name} · {t.queue}</span>
                        </span>
                        <StatePill state={t.state} />
                        <span aria-hidden className={`text-sm font-semibold ${accent} transition group-hover:translate-x-0.5`}>→</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Trend */}
            {days.length > 0 ? (
              <TrendChart title="Activity — last 14 days" subtitle="Rentals started vs support tickets created" days={days} series={series} />
            ) : (
              <section aria-label="Activity trend" className={`px-4 py-10 text-center text-sm ${card} ${secondary}`}>
                No rental activity yet — the trend chart appears when rentals begin.
              </section>
            )}

            {/* Funnel + leaderboard */}
            <div className="grid gap-4 lg:grid-cols-2">
              <FunnelChart title="Rental journey" subtitle="Last 30 days · first-party events" steps={funnelSteps} />
              <LeaderboardChart title="Station revenue" subtitle="Gross captured less refunds · last 30 days" rows={leaderboardRows} format={(v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
            </div>
          </div>

          {/* ── Right rail: actions + state modules ──────────────────── */}
          <div className="space-y-4">
            <section aria-labelledby="actions-title" className={`overflow-hidden ${card}`}>
              <ModuleHeading title="Quick actions" />
              <ul className="divide-y divide-[#eef1f5]">
                {ACTIONS.map((a) => (
                  <li key={a.href}>
                    <Link href={a.href} className="group flex items-center gap-3 px-4 py-3 transition hover:bg-[#f6f9fc]">
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[13px] font-semibold ${navy}`}>{a.title}</span>
                        <span className={`mt-0.5 block text-xs ${muted}`}>{a.desc}</span>
                      </span>
                      <span aria-hidden className={`text-sm font-semibold ${accent} transition group-hover:translate-x-0.5`}>→</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="network-title" className={`overflow-hidden ${card}`}>
              <ModuleHeading title="Network" href="/admin/fleet" action="Fleet" />
              <div className="divide-y divide-[#eef1f5]">
                <MetricRow label="Stations online" value={stationOnline ?? "—"} href="/admin/fleet" />
                <MetricRow label="Slots ready" value={slotsReady ?? "—"} href="/admin/inventory" />
                <MetricRow label="Power banks" value={num(stats?.powerBanks)} href="/admin/inventory" />
                <MetricRow label="Rentals today" value={num(stats?.rentalsToday)} href="/admin/rentals" />
                <MetricRow label="Maintenance visits" value={num(stats?.maintenanceVisits)} href="/admin/vending-ops" />
              </div>
            </section>

            <section aria-labelledby="money-title" className={`overflow-hidden ${card}`}>
              <ModuleHeading title="Money" href="/admin/finance" action="Finance" />
              <div className="divide-y divide-[#eef1f5]">
                <MetricRow label="Payouts scheduled" value={money(financeSummary?.payouts.scheduledCents)} href="/admin/payouts" />
                <MetricRow label="Refunds awaiting" value={num(refundsAwaiting)} href="/admin/support/refunds" alert={(refundsAwaiting ?? 0) > 0} />
                <MetricRow label="Disputes open" value={num(disputesOpen)} href="/admin/disputes" alert={(disputesOpen ?? 0) > 0} />
              </div>
            </section>

            <section aria-labelledby="pipeline-title" className={`overflow-hidden ${card}`}>
              <ModuleHeading title="Pipeline" href="/admin/partners" action="Partners" />
              <div className="divide-y divide-[#eef1f5]">
                <MetricRow label="Applications pending" value={stats?.applicationStates == null ? "—" : String(pick(stats.applicationStates, "pending"))} href="/admin/partners" />
                <MetricRow label="Active venues" value={stats?.venues == null ? "—" : String(pick(stats.venues, "true"))} href="/admin/partners/manage" />
                <MetricRow label="Unhandled inquiries" value={num(stats?.unhandledContacts)} href="/admin/inquiries" />
                <MetricRow label="Unassigned cases" value={num(metrics?.unassigned)} href="/admin/support?view=unassigned" />
              </div>
            </section>
          </div>
        </div>
      </div>
    </AdminGate>
  );
}
