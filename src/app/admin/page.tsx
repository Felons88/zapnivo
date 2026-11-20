export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import TrendChart from "@/components/TrendChart";
import { FunnelChart, LeaderboardChart } from "@/components/Charts";
import { getSessionUser, isStaff } from "@/lib/auth";
import { getAdminStats, pick, total } from "@/lib/admin-stats";
import { loadAdminInsights } from "@/lib/admin-insights";
import { fetchFinanceData, periodWindow, computeSummary } from "@/lib/admin-finance";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { slaStatus } from "@/lib/helpdesk/sla";
import type { Ticket } from "@/lib/helpdesk/types";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Operations dashboard", robots: { index: false, follow: false } };

type Stat = { label: string; value: string; detail: string; href: string; alert?: boolean };

function MetricCard({ stat }: { stat: Stat }) {
  return <Link href={stat.href} className="group flex min-h-40 flex-col rounded-2xl border border-[#dce5dc] bg-white p-5 shadow-[0_12px_32px_-28px_#163729] transition hover:-translate-y-0.5 hover:border-forest/45 hover:shadow-[0_18px_35px_-27px_#163729] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest">
    <span className="flex items-start justify-between gap-3 text-[11px] font-extrabold uppercase tracking-[.12em] text-[#60736b]"><span>{stat.label}</span><span aria-hidden="true" className="text-lg leading-none text-forest transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5">↗</span></span>
    <span className={`mt-auto block font-display text-4xl font-bold tracking-tight tabular-nums ${stat.alert ? "text-[#a24c24]" : "text-ink"}`}>{stat.value}</span>
    <span className="mt-1 block text-xs text-graphite">{stat.detail}</span>
  </Link>;
}

function SectionHeading({ eyebrow, title, href, action }: { eyebrow: string; title: string; href?: string; action?: string }) {
  return <div className="flex flex-wrap items-end justify-between gap-3">
    <div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-forest">{eyebrow}</p><h2 className="mt-1 font-display text-xl font-bold tracking-tight text-ink">{title}</h2></div>
    {href && <Link href={href} className="inline-flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-bold text-forest hover:bg-mist/60 focus-visible:outline-2 focus-visible:outline-forest">{action} <span aria-hidden="true">→</span></Link>}
  </div>;
}

function WorkLink({ number, title, description, href }: { number: string; title: string; description: string; href: string }) {
  return <Link href={href} className="group flex min-h-24 items-start gap-3 rounded-xl border border-[#e1e9e1] bg-[#fbfcfa] p-4 transition hover:border-forest/40 hover:bg-[#f4f8f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest">
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#e7efde] text-xs font-black text-forest">{number}</span>
    <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-ink">{title}</span><span className="mt-1 block text-xs leading-5 text-graphite">{description}</span></span>
    <span aria-hidden="true" className="text-forest transition group-hover:translate-x-0.5">→</span>
  </Link>;
}

export default async function AdminDashboard() {
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return <AdminGate title="Operations dashboard" nav="dashboard"><div /></AdminGate>;

  const [ctx, stats] = await Promise.all([defaultCtx(), getAdminStats()]);
  const [metrics, tickets] = ctx
    ? await Promise.all([computeMetrics(ctx.repo), ctx.repo.listTickets({ limit: 250 })])
    : [null, [] as Ticket[]];
  const db = serviceClient();
  const window = periodWindow(30);
  const financeData = user.role === "admin" && db ? await fetchFinanceData(db, window) : null;
  const financeSummary = financeData ? computeSummary(financeData, window) : null;
  const events = db ? (await db.from("business_events").select("name,occurred_at").gte("occurred_at", window.start).limit(20000)).data ?? [] : [];
  const insights = db ? await loadAdminInsights(db, events as { name: string }[]) : null;

  const now = new Date();
  const attention = tickets.filter((ticket) =>
    ticket.state !== "resolved" && ticket.state !== "closed" && ticket.aiState !== "ai_active" &&
    (ticket.priority === "urgent" || !ticket.assignedTo || slaStatus(ticket, now).firstResponse === "breached"),
  );
  const order = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  attention.sort((a, b) => order[a.priority] - order[b.priority] || a.createdAt.localeCompare(b.createdAt));
  const queue = attention.slice(0, 5);

  const fleetAttention = stats?.kioskStates == null ? null : pick(stats.kioskStates, "offline") + pick(stats.kioskStates, "stale");
  const stationTotal = stats?.kioskStates == null ? null : total(stats.kioskStates);
  const stationOnline = stats?.kioskStates == null ? null : pick(stats.kioskStates, "online");
  const activeRentals = stats?.rentalStates == null ? null : pick(stats.rentalStates, "active") + pick(stats.rentalStates, "dispense_pending");
  const readySlots = stats?.slotStates == null ? null : pick(stats.slotStates, "ready");
  const allSlots = stats?.slotStates == null ? null : total(stats.slotStates);
  const pendingPartners = stats?.applicationStates == null ? null : pick(stats.applicationStates, "pending");
  const date = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);
  const cards: Stat[] = [
    { label: "Cases needing a person", value: metrics?.needsHuman == null ? "—" : String(metrics.needsHuman), detail: "Open the priority support view", href: "/admin/support?view=person", alert: (metrics?.needsHuman ?? 0) > 0 },
    { label: "Fleet attention", value: fleetAttention == null ? "—" : String(fleetAttention), detail: "Offline or stale stations", href: "/admin/fleet?state=attention", alert: (fleetAttention ?? 0) > 0 },
    { label: "Active rentals", value: activeRentals == null ? "—" : String(activeRentals), detail: "Active and dispensing", href: "/admin/rentals" },
    user.role === "admin"
      ? { label: "Captured today", value: stats?.revenueTodayCents == null ? "—" : fmt(stats.revenueTodayCents), detail: "Captured payments only", href: "/admin/finance" }
      : { label: "Pending partners", value: pendingPartners == null ? "—" : String(pendingPartners), detail: "Applications awaiting review", href: "/admin/partners" },
  ];

  const rentalsByDay = stats?.rentalsByDay ?? {};
  const days = Object.keys(rentalsByDay).sort();
  const series = [
    { label: "Rentals started", color: "#2e7048", data: days.map((day) => rentalsByDay[day] ?? 0) },
    { label: "Support tickets", color: "#bf8352", data: days.map((day) => tickets.filter((ticket) => ticket.createdAt.slice(0, 10) === day).length) },
  ];
  const funnelSteps = (insights?.funnel ?? []).map((step) => ({ label: step.label, count: step.count, convPct: step.convPct }));
  const leaderboardRows = (insights?.stations ?? []).slice(0, 10).map((station) => ({ label: station.station, detail: station.venue ?? undefined, value: station.grossCents / 100, flag: station.bottomDecile ? "bottom decile" : undefined }));

  return <AdminGate title="Operations dashboard" nav="dashboard">
    <div className="space-y-7 pb-6">
      <header className="relative overflow-hidden rounded-3xl border border-[#d5e3d3] bg-[radial-gradient(circle_at_95%_0%,#dcf4c2_0%,transparent_34%),linear-gradient(130deg,#fafff7_0%,#ecf5e9_100%)] p-6 shadow-[0_20px_40px_-34px_#19452e] sm:p-8">
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl"><p className="text-[11px] font-extrabold uppercase tracking-[.18em] text-forest">Zapnivo operations · {date}</p><h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">Your work, in one place.</h1><p className="mt-3 max-w-xl text-sm leading-6 text-[#53665d]">Start with the cases and stations that need attention, then move into the right workspace. Counts come from current records.</p></div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto"><Link href="/admin/support?view=person" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-ink px-5 text-sm font-bold text-white transition hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest">Open priority queue <span aria-hidden="true">→</span></Link><Link href="/admin/search" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#b8cbb9] bg-white/80 px-5 text-sm font-bold text-ink transition hover:border-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest">Find a record</Link></div>
        </div>
      </header>

      <section aria-label="Operations snapshot" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map((card) => <MetricCard key={card.label} stat={card} />)}</section>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)]">
        <section aria-labelledby="priority-title" className="overflow-hidden rounded-2xl border border-[#dce5dc] bg-white shadow-[0_12px_32px_-28px_#163729]">
          <div className="flex items-start justify-between gap-4 border-b border-[#e4ebe5] px-5 py-4"><div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-forest">Customer care</p><h2 id="priority-title" className="mt-1 font-display text-xl font-bold text-ink">Priority case queue</h2><p className="mt-1 text-xs text-graphite">Urgent, unassigned, or first-response SLA breached</p></div><Link href="/admin/support?view=person" className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-bold text-forest hover:bg-mist/50">View inbox →</Link></div>
          {!ctx ? <p className="px-5 py-12 text-center text-sm text-graphite">Support data is unavailable in this environment.</p> : queue.length === 0 ? <div className="px-5 py-12 text-center"><p className="text-sm font-bold text-ink">No priority cases right now</p><p className="mt-1 text-xs text-graphite">New urgent, unassigned, or breached cases will appear here.</p></div> : <ul className="divide-y divide-[#edf0ed]">{queue.map((ticket) => <li key={ticket.id}><Link href={`/admin/support/${ticket.number}`} className="group flex min-h-19 items-center gap-3 px-5 py-3 transition hover:bg-[#f7faf5] focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-forest"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#eef3e8] text-xs font-black text-forest">{ticket.name?.slice(0, 1).toUpperCase() || "?"}</span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-bold text-ink">{ticket.subject || ticket.category}</span><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold capitalize ${ticket.priority === "urgent" ? "border-red-200 bg-red-50 text-red-700" : ticket.priority === "high" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-mist bg-[#f3f6f3] text-graphite"}`}>{ticket.priority}</span></span><span className="mt-1 block truncate text-xs text-graphite">{ticket.number} · {ticket.name} · {ticket.queue}</span></span><span className="hidden text-[11px] font-semibold capitalize text-graphite sm:block">{ticket.state.replace(/_/g, " ")}</span><span aria-hidden="true" className="text-forest transition group-hover:translate-x-0.5">→</span></Link></li>)}</ul>}
        </section>
        <section aria-labelledby="next-title" className="rounded-2xl border border-[#dce5dc] bg-white p-5 shadow-[0_12px_32px_-28px_#163729]"><div id="next-title"><SectionHeading eyebrow="Quick paths" title="What do you need to do?" /></div><div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-1"><WorkLink number="01" title="Resolve a customer issue" description="Work the inbox, review the account, and reply from the case." href="/admin/support?view=person" /><WorkLink number="02" title="Find a customer" description="Search accounts, rentals, payments, and support history." href="/admin/customers" /><WorkLink number="03" title="Check a station" description="Review devices that are offline, stale, or need service." href="/admin/fleet?state=attention" />{user.role === "admin" && <WorkLink number="04" title="Review financial operations" description="Open revenue, settlements, and payout reporting." href="/admin/finance" />}</div></section>
      </div>

      <section aria-label="Across the business" className="rounded-2xl border border-[#dce5dc] bg-white p-5 shadow-[0_12px_32px_-28px_#163729]"><SectionHeading eyebrow="At a glance" title="Across the business" href="/admin/analytics" action="View analytics" /><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
        { label: "Stations online", value: stationOnline == null || stationTotal == null ? "—" : `${stationOnline} / ${stationTotal}`, href: "/admin/fleet" },
        { label: "Ready slots", value: readySlots == null || allSlots == null ? "—" : `${readySlots} / ${allSlots}`, href: "/admin/inventory" },
        { label: "Unhandled inquiries", value: stats?.unhandledContacts ?? "—", href: "/admin/inquiries" },
        { label: "Partner applications", value: pendingPartners ?? "—", href: "/admin/partners" },
      ].map((item) => <Link key={item.label} href={item.href} className="rounded-xl bg-[#f3f7f1] p-4 hover:bg-[#eaf2e6] focus-visible:outline-2 focus-visible:outline-forest"><span className="block text-xs font-bold text-graphite">{item.label}</span><span className="mt-2 block text-xl font-bold tabular-nums text-ink">{item.value}</span></Link>)}</div></section>

      <section aria-label="Performance" className="space-y-4"><SectionHeading eyebrow="Performance" title="See what is changing" href="/admin/analytics" action="Explore reports" />{days.length > 0 ? <TrendChart title="Rentals and support" subtitle="Rentals started and support tickets created · last 14 days" days={days} series={series} /> : <div className="rounded-2xl border border-[#dce5dc] bg-white px-5 py-10 text-center text-sm text-graphite">No rental trend is available yet. The chart will appear when rentals begin.</div>}<div className="grid gap-4 lg:grid-cols-2"><FunnelChart title="Rental journey" subtitle="Last 30 days · recorded first-party events" steps={funnelSteps} /><LeaderboardChart title="Station revenue" subtitle="Gross captured less refunds · last 30 days" rows={leaderboardRows} format={(value) => "$" + value.toLocaleString(undefined, { maximumFractionDigits: 0 })} /></div></section>

      {user.role === "admin" && <section aria-label="Financial follow-up" className="grid gap-3 sm:grid-cols-3"><MetricCard stat={{ label: "Payouts scheduled", value: financeSummary ? fmt(financeSummary.payouts.scheduledCents) : "—", detail: "All-time scheduled records", href: "/admin/payouts" }} /><MetricCard stat={{ label: "Refunds awaiting", value: metrics?.refunds.requested == null ? "—" : String(metrics.refunds.requested), detail: "Requests pending a human decision", href: "/admin/support/refunds", alert: (metrics?.refunds.requested ?? 0) > 0 }} /><MetricCard stat={{ label: "Disputes open", value: stats?.disputesOpen == null ? "—" : String(stats.disputesOpen), detail: "Review payment disputes", href: "/admin/disputes", alert: (stats?.disputesOpen ?? 0) > 0 }} /></section>}
    </div>
  </AdminGate>;
}
