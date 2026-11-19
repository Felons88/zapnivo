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

export const metadata: Metadata = { title: "Operations workspace", robots: { index: false, follow: false } };

const FLOWS = [
  {
    n: "01", title: "Resolve a case", href: "/admin/support?view=person", cta: "Open the queue",
    steps: ["Triage the priority queue", "Read the customer 360", "Reply, escalate, or resolve"],
  },
  {
    n: "02", title: "Find a customer", href: "/admin/customers", cta: "Search a person",
    steps: ["Name, phone, or reference", "Open the full record", "Act: credit, rental, or ticket"],
  },
  {
    n: "03", title: "Check the network", href: "/admin/fleet?state=attention", cta: "Review attention",
    steps: ["Stations needing attention", "Open the station timeline", "Run a fleet command"],
  },
  {
    n: "04", title: "Move the money", href: "/admin/finance", cta: "Open finance",
    steps: ["Payouts scheduled", "Disputes and refunds", "Revenue assurance"],
  },
] as const;

function PulseRow({ label, value, href, alert = false }: { label: string; value: string; href: string; alert?: boolean }) {
  return (
    <Link href={href} className="group flex items-baseline justify-between gap-3 py-1.5">
      <span className="flex min-w-0 items-center gap-2 text-xs text-[#8fa6a8]">
        {alert ? <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" /> : null}
        <span className="truncate">{label}</span>
      </span>
      <span className={`shrink-0 text-sm font-bold tabular-nums ${alert ? "text-amber-300" : "text-white"} group-hover:text-lime`}>{value}</span>
    </Link>
  );
}

function PulseGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-white/10 pb-3 last:border-0 last:pb-0">
      <p className="pb-1 pt-2 text-[10px] font-extrabold uppercase tracking-[.18em] text-[#5f7a7e]">{title}</p>
      {children}
    </div>
  );
}

function PriorityDot({ p }: { p: Ticket["priority"] }) {
  const c = p === "urgent" ? "bg-red-500" : p === "high" ? "bg-orange-500" : p === "normal" ? "bg-gold" : "bg-silver";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c}`} aria-hidden />;
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

  const online = stats?.kioskStates == null ? "—" : `${pick(stats.kioskStates, "online")}/${total(stats.kioskStates)}`;
  const slots = stats?.slotStates == null ? "—" : `${pick(stats.slotStates, "ready")}/${total(stats.slotStates)}`;
  const openRentals = stats?.rentalStates == null ? "—" : String(pick(stats.rentalStates, "active") + pick(stats.rentalStates, "dispense_pending"));
  const fleetAttention = stats?.kioskStates == null ? "—" : String(pick(stats.kioskStates, "offline") + pick(stats.kioskStates, "stale"));
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);

  const funnelSteps = (insights?.funnel ?? []).map((f) => ({ label: f.label, count: f.count, convPct: f.convPct }));
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

  const rentalsByDay = stats?.rentalsByDay ?? {};
  const days = Object.keys(rentalsByDay).sort();
  const series = [
    { label: "Rentals started", color: "#4d9de0", data: days.map((d) => rentalsByDay[d] ?? 0) },
    { label: "Support tickets", color: "#e8915a", data: days.map((d) => tickets.filter((t: Ticket) => t.createdAt.slice(0, 10) === d).length) },
  ];

  const money = (v: number | null | undefined) => (v == null ? "—" : fmt(v));
  const num = (v: number | null | undefined) => (v == null ? "—" : String(v));
  const refundsAwaiting = metrics?.refunds.requested ?? null;
  const disputesOpen = stats?.disputesOpen ?? null;

  return (
    <AdminGate title="Mission control" nav="dashboard">
      {/* Mission-control canvas — paints its own dark surface over the shell's light bg */}
      <div className="-mx-5 -my-5 min-h-[calc(100vh-8rem)] bg-[#0c161a] px-5 py-5 text-white md:-mx-8 md:px-8">
        {/* ── Top strip: date · search · queue ──────────────────────────── */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-lime">Mission control · {today}</p>
            <h2 className="mt-1 text-xl font-bold tracking-tight">See the work. Move it forward.</h2>
          </div>
          <form method="get" action="/admin/search" className="flex min-w-0 flex-1 gap-2 lg:max-w-md">
            <input name="q" required minLength={2} aria-label="Search the workspace" placeholder="Customer, ticket, rental, or tool…" className="min-h-10 min-w-0 flex-1 rounded-lg border border-white/15 bg-white/10 px-3 text-sm text-white outline-none placeholder:text-[#7d9597]" />
            <button className="rounded-lg bg-lime px-4 text-sm font-bold text-ink">Search</button>
          </form>
          <Link href="/admin/support?view=person" className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-white/20 px-4 text-sm font-bold hover:bg-white/10">
            Priority queue{metrics ? ` · ${metrics.needsHuman}` : ""} →
          </Link>
        </div>

        {/* ── Three-column deck ────────────────────────────────────────── */}
        <div className="mt-5 grid gap-5 xl:grid-cols-[240px_minmax(0,1fr)_300px]">
          {/* LEFT — live pulse rail */}
          <aside aria-label="Live operations" className="space-y-2 rounded-xl border border-white/10 bg-[#0f1c22] p-4">
            <p className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.18em] text-lime">
              <span aria-hidden className="relative flex h-2 w-2"><span className="absolute h-full w-full animate-ping rounded-full bg-lime opacity-60" /><span className="relative h-2 w-2 rounded-full bg-lime" /></span>
              Live pulse
            </p>
            <PulseGroup title="Customer care">
              <PulseRow label="Needs a person" value={num(metrics?.needsHuman)} href="/admin/support?view=person" alert={(metrics?.needsHuman ?? 0) > 0} />
              <PulseRow label="Unassigned" value={num(metrics?.unassigned)} href="/admin/support?view=unassigned" />
              <PulseRow label="Urgent" value={num(metrics?.urgent)} href="/admin/support?priority=urgent" alert={(metrics?.urgent ?? 0) > 0} />
              <PulseRow label="Inquiries" value={num(stats?.unhandledContacts)} href="/admin/inquiries" />
            </PulseGroup>
            <PulseGroup title="Network">
              <PulseRow label="Stations online" value={online} href="/admin/fleet" />
              <PulseRow label="Slots ready" value={slots} href="/admin/fleet" />
              <PulseRow label="Power banks" value={num(stats?.powerBanks)} href="/admin/inventory" />
              <PulseRow label="Rentals live" value={openRentals} href="/admin/rentals" />
              <PulseRow label="Fleet attention" value={fleetAttention} href="/admin/fleet?state=attention" alert={stats?.kioskStates != null && pick(stats.kioskStates, "offline") + pick(stats.kioskStates, "stale") > 0} />
            </PulseGroup>
            <PulseGroup title="Money">
              <PulseRow label="Captured today" value={money(stats?.revenueTodayCents)} href="/admin/finance" />
              <PulseRow label="Rentals today" value={num(stats?.rentalsToday)} href="/admin/rentals" />
              <PulseRow label="Payouts scheduled" value={money(financeSummary?.payouts.scheduledCents)} href="/admin/payouts" />
              <PulseRow label="Refunds awaiting" value={num(refundsAwaiting)} href="/admin/support/refunds" alert={(refundsAwaiting ?? 0) > 0} />
            </PulseGroup>
            <PulseGroup title="Partners & risk">
              <PulseRow label="Applications" value={stats?.applicationStates == null ? "—" : String(pick(stats.applicationStates, "pending"))} href="/admin/partners" />
              <PulseRow label="Active venues" value={stats?.venues == null ? "—" : String(pick(stats.venues, "true"))} href="/admin/partners/manage" />
              <PulseRow label="Disputes open" value={num(disputesOpen)} href="/admin/disputes" alert={(disputesOpen ?? 0) > 0} />
              <PulseRow label="Maintenance" value={num(stats?.maintenanceVisits)} href="/admin/vending-ops" />
            </PulseGroup>
          </aside>

          {/* CENTER — work surface: trend + queue */}
          <div className="min-w-0 space-y-5">
            {days.length > 0 ? (
              <TrendChart dark title="Last 14 days — rentals & tickets" subtitle="Rentals started vs support tickets created" days={days} series={series} />
            ) : (
              <section aria-label="Activity trend" className="rounded-xl border border-white/10 bg-[#0f1c22] px-4 py-6 text-center text-[#8fa6a8]">
                <p>No rental data yet — the chart renders when rentals begin.</p>
              </section>
            )}

            <section aria-labelledby="queue-title" className="overflow-hidden rounded-xl border border-white/10 bg-[#0f1c22]">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <h2 id="queue-title" className="text-sm font-extrabold uppercase tracking-wider">Priority case queue</h2>
                <Link href="/admin/support?view=person" className="text-xs font-bold text-lime hover:underline">Full inbox →</Link>
              </div>
              {!ctx ? (
                <p className="px-4 py-8 text-sm text-[#8fa6a8]">Support data is unavailable in this environment.</p>
              ) : queue.length === 0 ? (
                <p className="px-4 py-8 text-sm text-[#8fa6a8]">No unassigned, urgent, or breached cases in the current queue.</p>
              ) : (
                <ul className="divide-y divide-white/10">
                  {queue.map((t) => (
                    <li key={t.id}>
                      <Link href={"/admin/support/" + t.number} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-white/5">
                        <PriorityDot p={t.priority} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-bold">{t.subject || t.category}</span>
                          <span className="block truncate text-xs text-[#7d9597]">{t.number} · {t.name} · {t.queue}</span>
                        </span>
                        <span className="hidden rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-bold capitalize text-[#8fa6a8] sm:block">
                          {t.state.replace(/_/g, " ")}
                        </span>
                        <span className="text-sm font-bold text-lime transition group-hover:translate-x-1" aria-hidden>→</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Journey + stations, compact twin row */}
            <div className="grid gap-5 lg:grid-cols-2">
              <FunnelChart dark title="Rental journey" subtitle="Last 30 days · first-party events" steps={funnelSteps} />
              <LeaderboardChart dark title="Station revenue leaderboard" subtitle="Gross captured − refunded · 30 days · flagged = bottom decile" rows={leaderboardRows} format={(v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
            </div>
          </div>

          {/* RIGHT — flows rail */}
          <aside aria-label="User flows" className="space-y-3">
            <p className="px-1 text-[10px] font-extrabold uppercase tracking-[.18em] text-[#5f7a7e]">Your next move</p>
            {FLOWS.map((f) => (
              <Link key={f.href} href={f.href} className="group block rounded-xl border border-white/10 bg-[#0f1c22] p-4 transition hover:border-lime/40 hover:bg-[#122329]">
                <span className="flex items-center justify-between">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-lime">{f.n}</span>
                  <span className="text-sm font-bold text-lime transition group-hover:translate-x-0.5" aria-hidden>↗</span>
                </span>
                <span className="mt-1.5 block text-sm font-bold leading-tight">{f.title}</span>
                <ol className="mt-2 space-y-1">
                  {f.steps.map((s, i) => (
                    <li key={s} className="flex items-start gap-2 text-[11px] leading-4 text-[#8fa6a8]">
                      <span className="mt-px grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-white/10 text-[8px] font-extrabold text-[#8fa6a8]">{i + 1}</span>
                      {s}
                    </li>
                  ))}
                </ol>
                <span className="mt-3 inline-flex min-h-8 items-center rounded-lg bg-white/10 px-3 text-[11px] font-bold text-white group-hover:bg-lime group-hover:text-ink">{f.cta}</span>
              </Link>
            ))}
          </aside>
        </div>
      </div>
    </AdminGate>
  );
}
