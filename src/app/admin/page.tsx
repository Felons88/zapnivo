export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { getAdminStats, pick, total } from "@/lib/admin-stats";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { slaStatus } from "@/lib/helpdesk/sla";
import type { Ticket } from "@/lib/helpdesk/types";
import { loadAdminInsights, journeyFunnel } from "@/lib/admin-insights";
import { serviceClient } from "@/lib/supabase";
import { fetchFinanceData, periodWindow, computeSummary } from "@/lib/admin-finance";
import { fmt } from "@/lib/pricing";
import TrendChart from "@/components/TrendChart";
import { StatTile, Panel, Rows, FunnelChart, LeaderboardChart } from "@/components/Charts";

export const metadata: Metadata = { title: "Operations workspace", robots: { index: false, follow: false } };

function PriorityBadge({ p }: { p: Ticket["priority"] }) {
  const c = p === "urgent" ? "bg-red-500" : p === "high" ? "bg-orange-500" : p === "normal" ? "bg-gold" : "bg-silver";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c}`} aria-hidden />;
}

export default async function AdminDashboard() {
  const [ctx, stats] = await Promise.all([defaultCtx(), getAdminStats()]);

  // Tickets & metrics
  const [metrics, tickets] = ctx
    ? await Promise.all([computeMetrics(ctx.repo), ctx.repo.listTickets({ limit: 250 })])
    : [null, [] as Ticket[]];

  // Finance (last 30 days)
  const db = serviceClient();
  const financeWindow = periodWindow(30);
  const financeData = db ? await fetchFinanceData(db, financeWindow) : null;
  const financeSummary = financeData ? computeSummary(financeData, financeWindow) : null;

  // Insights (business events for funnel + station leaderboard + weekly trends)
  const events = db
    ? (await db.from("business_events").select("name,occurred_at").gte("occurred_at", financeWindow.start).limit(20000)).data ?? []
    : [];
  const insights = db ? await loadAdminInsights(db, events as { name: string }[]) : null;

  // ── Derived data for the page ──────────────────────────────────────────────
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

  const online = stats?.kioskStates == null ? "—" : `${pick(stats.kioskStates, "online")}/${total(stats.kioskStates)}`;
  const slots = stats?.slotStates == null ? "—" : `${pick(stats.slotStates, "ready")}/${total(stats.slotStates)}`;
  const openRentals = stats?.rentalStates == null ? "—" : String(pick(stats.rentalStates, "active") + pick(stats.rentalStates, "dispense_pending"));
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);

  // Rental journey funnel from insights (last 30 days) — counts from business_events
  const funnel = insights?.funnel ?? journeyFunnel(
    new Map(events.map((e) => [e.name, 0])), // empty
  );
  const funnelSteps = funnel.map((f) => ({ label: f.label, count: f.count, convPct: f.convPct }));

  // Station leaderboard (top 10 + flagged bottom decile)
  const stations = insights?.stations ?? null;
  const topStations = stations?.slice(0, 10) ?? null;
  const bottomStations = stations?.filter((s) => s.bottomDecile).map((s) => s.station) ?? [];
  const leaderboardRows =
    topStations?.map((s) => ({
      label: s.station,
      detail: s.venue ?? undefined,
      value: s.grossCents / 100,
      flag: bottomStations.includes(s.station) ? "bottom decile" : undefined,
    })) ?? [];

  // 14-day rentals vs tickets for the trend chart
  const rentalsByDay = stats?.rentalsByDay ?? {};
  const days = Object.keys(rentalsByDay).sort();
  const rentals14 = days.map((d) => rentalsByDay[d] ?? 0);
  const tickets14 = days.map((d) => tickets.filter((t: Ticket) => t.createdAt.slice(0, 10) === d).length);
  const series = [
    { label: "Rentals started", color: "#2a78d6", data: rentals14 },
    { label: "Support tickets", color: "#eb6834", data: tickets14 },
  ];

  const capturedToday = stats?.revenueTodayCents;
  const capturedTodayCount = stats?.revenueTodayCount;
  const refundsAwaiting = metrics?.refunds.requested ?? 0;
  const disputesOpen = stats?.disputesOpen;

  return (
    <AdminGate title="Operations workspace" nav="dashboard">
      <div className="space-y-4">
        {/* ── Command bar ────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 rounded-2xl bg-[#101d22] px-5 py-4 text-white lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-lime">
              Command center · {today}
            </p>
            <h2 className="mt-1 truncate text-lg font-bold tracking-tight">See the work. Move it forward.</h2>
          </div>
          <form method="get" action="/admin/search" className="flex min-w-0 flex-1 gap-2 lg:max-w-md">
            <input
              name="q"
              required
              minLength={2}
              aria-label="Search the workspace"
              placeholder="Customer, ticket, rental, or tool…"
              className="min-h-10 min-w-0 flex-1 rounded-lg border border-white/20 bg-white px-3 text-sm text-ink outline-none"
            />
            <button className="rounded-lg bg-lime px-4 text-sm font-bold text-ink">Search</button>
          </form>
          <Link href="/admin/support?view=person" className="inline-flex min-h-10 shrink-0 items-center rounded-lg border border-white/30 px-4 text-sm font-bold hover:bg-white/10">
            Priority queue →
          </Link>
        </section>

        {/* ── KPI overview — four domain groups ──────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* Customer care */}
          <StatTile label="Needs a person" value={metrics?.needsHuman ?? "—"} href="/admin/support?view=person" tone="urgent" />
          <StatTile label="Unassigned" value={metrics?.unassigned ?? "—"} href="/admin/support?view=unassigned" />
          <StatTile label="Urgent" value={metrics?.urgent ?? "—"} href="/admin/support?priority=urgent" />
          <StatTile label="Inquiries unhandled" value={stats?.unhandledContacts ?? "—"} href="/admin/inquiries" />

          {/* Network */}
          <StatTile label="Stations online" value={online} href="/admin/fleet" />
          <StatTile label="Slots ready" value={slots} href="/admin/fleet" />
          <StatTile label="Power banks live" value={stats?.powerBanks ?? "—"} href="/admin/inventory" />
          <StatTile label="Rentals live" value={openRentals} href="/admin/rentals" />

          {/* Commerce */}
          <StatTile label="Rentals today" value={stats?.rentalsToday ?? "—"} href="/admin/rentals" />
          <StatTile label="Revenue captured today" value={capturedToday == null ? "—" : fmt(capturedToday)} sub={capturedTodayCount == null ? "" : `${capturedTodayCount} txn`} href="/admin/finance" />
          <StatTile label="Payouts scheduled" value={financeSummary?.payouts.scheduledCents ? fmt(financeSummary.payouts.scheduledCents) : "—"} sub={financeSummary?.payouts.scheduledCount ? `${financeSummary.payouts.scheduledCount} pending` : ""} href="/admin/payouts" />
          <StatTile label="Refunds awaiting decision" value={refundsAwaiting} href="/admin/support/refunds" tone={refundsAwaiting > 0 ? "urgent" : "default"} />

          {/* Partners & finance */}
          <StatTile label="Applications pending" value={pick(stats?.applicationStates, "pending") ?? "—"} href="/admin/partners" />
          <StatTile label="Active venues" value={pick(stats?.venues, "true") ?? "—"} href="/admin/partners/manage" />
          <StatTile label="Maintenance visits" value={stats?.maintenanceVisits ?? "—"} href="/admin/vending-ops" />
          <StatTile label="Disputes open" value={disputesOpen ?? "—"} href="/admin/disputes" tone={disputesOpen && disputesOpen > 0 ? "urgent" : "default"} />
        </div>

        {/* ── Main grid: trend + queue on left, panels on right ─────────────── */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <div className="space-y-4">
            {/* Trend chart */}
            {days.length > 0 ? (
              <TrendChart
                title="Last 14 days — rentals & tickets"
                subtitle="Rentals started (blue) vs support tickets created (orange)"
                days={days}
                series={series}
              />
            ) : (
              <section aria-label="Activity trend" className="rounded-xl border border-[#dfe6df] bg-white px-4 py-6 text-center text-graphite">
                <p>No rental data yet — the chart renders when rentals begin.</p>
              </section>
            )}

            {/* Priority queue */}
            <section aria-labelledby="queue-title" className="overflow-hidden rounded-xl border border-[#dfe6df] bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-mist px-4 py-3">
                <h2 id="queue-title" className="text-sm font-extrabold uppercase tracking-wider text-ink">
                  Priority case queue
                </h2>
                <Link href="/admin/support?view=person" className="text-xs font-bold text-forest hover:underline">
                  Full inbox →
                </Link>
              </div>
              {!ctx ? (
                <p className="px-4 py-8 text-sm text-graphite">Support data is unavailable in this environment.</p>
              ) : queue.length === 0 ? (
                <p className="px-4 py-8 text-sm text-graphite">No unassigned, urgent, or breached cases in the current queue.</p>
              ) : (
                <ul className="divide-y divide-mist">
                  {queue.map((t) => (
                    <li key={t.id}>
                      <Link href={"/admin/support/" + t.number} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-[#f4f8ef]">
                        <PriorityBadge p={t.priority} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-bold">{t.subject || t.category}</span>
                          <span className="block truncate text-xs text-graphite">{t.number} · {t.name} · {t.queue}</span>
                        </span>
                        <span className="hidden rounded-full bg-mist px-2 py-0.5 text-[11px] font-bold capitalize text-graphite sm:block">
                          {t.state.replace(/_/g, " ")}
                        </span>
                        <span className="text-sm font-bold text-forest transition group-hover:translate-x-1" aria-hidden>
                          →
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* Right column — domain panels */}
          <div className="grid gap-4">
            <Panel title="Network care" action={{ href: "/admin/fleet", label: "All stations" }}>
              <Rows
                items={[
                  { label: "Online", value: online, href: "/admin/fleet" },
                  { label: "Slots ready", value: slots, href: "/admin/fleet" },
                  { label: "Power banks", value: stats?.powerBanks ?? "—", href: "/admin/inventory" },
                  { label: "Rentals live", value: openRentals, href: "/admin/rentals" },
                  { label: "Fleet attention", value: stats?.kioskStates ? String(pick(stats.kioskStates, "offline") + pick(stats.kioskStates, "stale")) : "—", href: "/admin/fleet?state=attention" },
                ]}
              />
            </Panel>

            <Panel title="Commerce" action={{ href: "/admin/finance", label: "Full ledger" }}>
              <Rows
                items={[
                  { label: "Rentals today", value: stats?.rentalsToday ?? "—", href: "/admin/rentals" },
                  { label: "Captured today", value: capturedToday == null ? "—" : fmt(capturedToday), href: "/admin/finance" },
                  { label: "Refunds awaiting decision", value: refundsAwaiting, href: "/admin/support/refunds", tone: refundsAwaiting > 0 ? "urgent" : undefined },
                  { label: "Payouts scheduled", value: financeSummary?.payouts.scheduledCents ? fmt(financeSummary.payouts.scheduledCents) : "—", href: "/admin/payouts" },
                ]}
              />
            </Panel>

            <Panel title="Partners" action={{ href: "/admin/partners", label: "Partner workspace" }}>
              <Rows
                items={[
                  { label: "Applications pending", value: pick(stats?.applicationStates, "pending") ?? "—", href: "/admin/partners" },
                  { label: "Active venues", value: pick(stats?.venues, "true") ?? "—", href: "/admin/partners/manage" },
                  { label: "Agreements active", value: pick(stats?.applicationStates, "active") ?? "—", href: "/admin/agreements" },
                  { label: "Maintenance visits", value: stats?.maintenanceVisits ?? "—", href: "/admin/vending-ops" },
                ]}
              />
            </Panel>

            <Panel title="Finance & risk" action={{ href: "/admin/finance", label: "Revenue overview" }}>
              <Rows
                items={[
                  { label: "Captured (30 d)", value: financeSummary?.grossCapturedCents ? fmt(financeSummary.grossCapturedCents) : "—", href: "/admin/finance" },
                  { label: "Net platform (30 d)", value: financeSummary?.netPlatformCents ? fmt(financeSummary.netPlatformCents) : "—", href: "/admin/finance" },
                  { label: "Refunds issued (30 d)", value: financeSummary?.refundsCents ? fmt(financeSummary.refundsCents) : "—", href: "/admin/support/refunds" },
                  { label: "Disputes open", value: disputesOpen ?? "—", href: "/admin/disputes", tone: disputesOpen && disputesOpen > 0 ? "urgent" : undefined },
                  { label: "Investigations", value: "—", href: "/admin/finance/investigations" },
                ]}
              />
            </Panel>
          </div>
        </div>

        {/* ── Full-width: funnel + leaderboard ────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-2">
          <FunnelChart title="Rental journey" subtitle="Last 30 days · first-party events" steps={funnelSteps} />

          <LeaderboardChart
            title="Station revenue leaderboard"
            subtitle="Gross captured − refunded · last 30 days · flagged = bottom decile"
            rows={leaderboardRows}
            format={(v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          />
        </div>

        {/* ── Daily actions (kept from original) ──────────────────────────── */}
        <section aria-label="Workflows" className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
          {[
            { title: "Resolve a customer issue", detail: "Priority queue and case history", href: "/admin/support?view=person" },
            { title: "Find a customer", detail: "Person, rental, ticket, or reference", href: "/admin/search" },
            { title: "Investigate a station", detail: "Fleet health and slot readiness", href: "/admin/fleet?state=attention" },
            { title: "Handle incoming contact", detail: "Email and SMS conversations", href: "/admin/receptionist" },
          ].map((route, i) => (
            <Link
              key={route.href}
              href={route.href}
              className="group flex items-center gap-3 rounded-xl border border-[#dfe6df] bg-white px-4 py-3 transition hover:-translate-y-px hover:shadow"
            >
              <span className="text-xs font-extrabold tracking-wider text-forest">{"0" + (i + 1)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">{route.title}</span>
                <span className="block truncate text-xs text-graphite">{route.detail}</span>
              </span>
              <span className="text-forest transition group-hover:translate-x-0.5" aria-hidden>
                ↗
              </span>
            </Link>
          ))}
        </section>
      </div>
    </AdminGate>
  );
}