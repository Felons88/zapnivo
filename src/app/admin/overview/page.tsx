export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { getAdminStats, pick, total } from "@/lib/admin-stats";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { slaStatus } from "@/lib/helpdesk/sla";
import type { Ticket } from "@/lib/helpdesk/types";
import { serviceClient } from "@/lib/supabase";
import { fetchFinanceData, periodWindow, computeSummary } from "@/lib/admin-finance";
import { fmt } from "@/lib/pricing";
import TrendChart from "@/components/TrendChart";

export const metadata: Metadata = { title: "Mission control", robots: { index: false, follow: false } };

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
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);

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

  const headline: { label: string; value: string; hint: string; href: string; alert?: boolean }[] = [
    { label: "Needs a person", value: num(metrics?.needsHuman), hint: "cases waiting", href: "/admin/support?view=person", alert: (metrics?.needsHuman ?? 0) > 0 },
    { label: "Fleet attention", value: num(fleetAttention), hint: "offline / stale", href: "/admin/fleet?state=attention", alert: (fleetAttention ?? 0) > 0 },
    { label: "Active rentals", value: num(activeRentals), hint: "in progress", href: "/admin/rentals" },
    { label: "Captured today", value: money(stats?.revenueTodayCents), hint: "payments", href: "/admin/finance" },
    { label: "Rentals today", value: num(stats?.rentalsToday), hint: "started", href: "/admin/rentals" },
  ];

  return (
    <AdminGate title="Mission control" nav="overview">
      <div className="mx-auto max-w-5xl">
        {/* ── Greeting ───────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className={`text-xl font-bold tracking-tight ${navy}`}>{greeting}</h1>
            <p className={`mt-0.5 text-sm ${secondary}`}>{today} · here's what needs you.</p>
          </div>
          <Link href="/admin/support?view=person" className={`inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg border border-[#e3e8ee] bg-white px-4 text-[13px] font-semibold ${navy} shadow-[0_1px_2px_rgba(10,37,64,.04)] transition hover:border-[#c7cfda]`}>
            Priority queue{metrics ? ` (${metrics.needsHuman})` : ""}
          </Link>
        </div>

        {/* ── Today at a glance — one card, inline stats (Stripe overview) ── */}
        <section aria-label="Today at a glance" className={`mt-4 overflow-hidden ${card}`}>
          <div className="grid grid-cols-2 divide-[#e3e8ee] sm:grid-cols-3 sm:divide-x lg:grid-cols-5">
            {headline.map((s) => (
              <Link key={s.label} href={s.href} className="group p-4 transition hover:bg-[#f6f9fc]">
                <span className={`flex items-center gap-1.5 text-[13px] font-medium ${secondary}`}>
                  {s.alert ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#df1b41]" /> : null}
                  {s.label}
                </span>
                <span className={`mt-1 block text-[26px] font-semibold leading-8 tracking-tight tabular-nums ${s.alert ? "text-[#df1b41]" : navy}`}>{s.value}</span>
                <span className={`mt-0.5 block text-xs ${muted}`}>{s.hint} <span className={`${accent} opacity-0 transition group-hover:opacity-100`}>→</span></span>
              </Link>
            ))}
          </div>
        </section>

        {/* ── Work surface + side rail ───────────────────────────────── */}
        <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-4">
            {/* Needs attention — the work */}
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
              <div>
                <TrendChart title="Activity — last 14 days" subtitle="Rentals started vs support tickets created" days={days} series={series} />
                <p className={`mt-2 text-right text-xs ${muted}`}>
                  Funnels, station revenue, and cohorts live in <Link href="/admin/analytics" className={`font-medium ${accent} hover:text-[#0a2540]`}>Analytics →</Link>
                </p>
              </div>
            ) : (
              <section aria-label="Activity trend" className={`px-4 py-10 text-center text-sm ${card} ${secondary}`}>
                No rental activity yet — the trend chart appears when rentals begin.
              </section>
            )}
          </div>

          {/* ── Right rail: actions + one ops card ───────────────────── */}
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

            <section aria-labelledby="ops-title" className={`overflow-hidden ${card}`}>
              <ModuleHeading title="Operations" href="/admin/fleet" action="Fleet" />
              <div className="divide-y divide-[#eef1f5]">
                <MetricRow label="Stations online" value={stationOnline ?? "—"} href="/admin/fleet" />
                <MetricRow label="Slots ready" value={slotsReady ?? "—"} href="/admin/inventory" />
                <MetricRow label="Power banks" value={num(stats?.powerBanks)} href="/admin/inventory" />
                <MetricRow label="Maintenance visits" value={num(stats?.maintenanceVisits)} href="/admin/vending-ops" />
                <MetricRow label="Payouts scheduled" value={money(financeSummary?.payouts.scheduledCents)} href="/admin/payouts" />
                <MetricRow label="Refunds awaiting" value={num(refundsAwaiting)} href="/admin/support/refunds" alert={(refundsAwaiting ?? 0) > 0} />
                <MetricRow label="Disputes open" value={num(disputesOpen)} href="/admin/disputes" alert={(disputesOpen ?? 0) > 0} />
                <MetricRow label="Applications pending" value={stats?.applicationStates == null ? "—" : String(pick(stats.applicationStates, "pending"))} href="/admin/partners" />
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
