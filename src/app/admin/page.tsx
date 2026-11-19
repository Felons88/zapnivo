export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { getAdminStats, pick, total } from "@/lib/admin-stats";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { slaStatus } from "@/lib/helpdesk/sla";
import type { Ticket } from "@/lib/helpdesk/types";

export const metadata: Metadata = { title: "Operations workspace", robots: { index: false, follow: false } };

function Stat({ label, value, href, urgent = false }: { label: string; value: string; href: string; urgent?: boolean }) {
  return <Link href={href} className={"group rounded-xl border px-3 py-2.5 transition hover:-translate-y-px hover:shadow " + (urgent ? "border-[#f0d7cb] bg-[#fff8f3]" : "border-[#dfe6df] bg-white")}>
    <span className="flex items-center justify-between gap-2 text-[10px] font-extrabold uppercase tracking-wider text-graphite">{label}<span className="text-forest opacity-0 transition group-hover:opacity-100" aria-hidden>↗</span></span>
    <span className="mt-0.5 block text-2xl font-bold leading-8 tracking-tight text-ink">{value}</span>
  </Link>;
}

const actions = [
  { title: "Resolve a customer issue", detail: "Priority queue and case history", href: "/admin/support?view=person" },
  { title: "Find a customer", detail: "Person, rental, ticket, or reference", href: "/admin/search" },
  { title: "Investigate a station", detail: "Fleet health and slot readiness", href: "/admin/fleet?state=attention" },
  { title: "Handle incoming contact", detail: "Email and SMS conversations", href: "/admin/receptionist" },
] as const;

export default async function AdminDashboard() {
  const [ctx, stats] = await Promise.all([defaultCtx(), getAdminStats()]);
  const [metrics, tickets] = ctx ? await Promise.all([computeMetrics(ctx.repo), ctx.repo.listTickets({ limit: 250 })]) : [null, [] as Ticket[]];
  const now = new Date();
  const attention = tickets.filter((t) => t.state !== "resolved" && t.state !== "closed" && t.aiState !== "ai_active"
    && (t.priority === "urgent" || !t.assignedTo || slaStatus(t, now).firstResponse === "breached"));
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  attention.sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt));
  const queue = attention.slice(0, 6);
  const online = stats?.kioskStates == null ? "—" : String(pick(stats.kioskStates, "online")) + "/" + String(total(stats.kioskStates));
  const openRentals = stats?.rentalStates == null ? "—" : String(pick(stats.rentalStates, "active") + pick(stats.rentalStates, "dispense_pending"));
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);

  return <AdminGate title="Operations workspace" nav="dashboard">
    <div className="space-y-4">
      {/* Command bar — greeting, search, primary CTA in one slim row */}
      <section className="flex flex-col gap-3 rounded-2xl bg-[#101d22] px-5 py-4 text-white lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-lime">Command center · {today}</p>
          <h2 className="mt-1 truncate text-lg font-bold tracking-tight">See the work. Move it forward.</h2>
        </div>
        <form method="get" action="/admin/search" className="flex min-w-0 flex-1 gap-2 lg:max-w-md">
          <input name="q" required minLength={2} aria-label="Search the workspace" placeholder="Customer, ticket, rental, or tool…" className="min-h-10 min-w-0 flex-1 rounded-lg border border-white/20 bg-white px-3 text-sm text-ink outline-none" />
          <button className="rounded-lg bg-lime px-4 text-sm font-bold text-ink">Search</button>
        </form>
        <Link href="/admin/support?view=person" className="inline-flex min-h-10 shrink-0 items-center rounded-lg border border-white/30 px-4 text-sm font-bold hover:bg-white/10">Priority queue →</Link>
      </section>

      {/* Live pulse — one dense strip, all sources */}
      <section aria-label="Live operations" className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-7">
        <Stat label="Needs a person" value={metrics ? String(metrics.needsHuman) : "—"} href="/admin/support?view=person" urgent />
        <Stat label="Unassigned" value={metrics ? String(metrics.unassigned) : "—"} href="/admin/support?view=unassigned" />
        <Stat label="Stations online" value={online} href="/admin/fleet" />
        <Stat label="Rentals live" value={openRentals} href="/admin/rentals" />
        <Stat label="Inquiries" value={stats?.unhandledContacts == null ? "—" : String(stats.unhandledContacts)} href="/admin/inquiries" />
        <Stat label="Rentals today" value={stats?.rentalsToday == null ? "—" : String(stats.rentalsToday)} href="/admin/rentals" />
        <Stat label="Slots ready" value={stats?.slotStates == null ? "—" : String(pick(stats.slotStates, "ready")) + "/" + String(total(stats.slotStates))} href="/admin/fleet" />
      </section>

      {/* Queue + jump links */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,.5fr)]">
        <section aria-labelledby="queue-title" className="overflow-hidden rounded-xl border border-[#dfe6df] bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-mist px-4 py-3">
            <h2 id="queue-title" className="text-sm font-extrabold uppercase tracking-wider text-ink">Priority case queue</h2>
            <Link href="/admin/support?view=person" className="text-xs font-bold text-forest hover:underline">Full inbox →</Link>
          </div>
          {!ctx ? <p className="px-4 py-8 text-sm text-graphite">Support data is unavailable in this environment.</p> : queue.length === 0 ? <p className="px-4 py-8 text-sm text-graphite">No unassigned, urgent, or breached cases in the current queue.</p> :
            <ul className="divide-y divide-mist">{queue.map((t) => <li key={t.id}><Link href={"/admin/support/" + t.number} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-[#f4f8ef]"><span className={"h-8 w-1 shrink-0 rounded-full " + (t.priority === "urgent" ? "bg-red-500" : "bg-gold")} aria-hidden /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{t.subject || t.category}</span><span className="block truncate text-xs text-graphite">{t.number} · {t.name} · {t.queue}</span></span><span className="hidden rounded-full bg-mist px-2 py-0.5 text-[11px] font-bold capitalize text-graphite sm:block">{t.state.replace(/_/g, " ")}</span><span className="text-sm font-bold text-forest transition group-hover:translate-x-1">→</span></Link></li>)}</ul>}
        </section>
        <section aria-labelledby="actions-title" className="rounded-xl border border-[#dfe6df] bg-white px-4 py-3">
          <h2 id="actions-title" className="text-sm font-extrabold uppercase tracking-wider text-ink">Daily actions</h2>
          <div className="mt-1 divide-y divide-mist">
            {[
              { label: "Customer profiles", href: "/admin/customers", detail: "History, rentals, cases" },
              { label: "Email and SMS desk", href: "/admin/receptionist", detail: "Incoming conversations" },
              { label: "Fleet attention", href: "/admin/fleet?state=attention", detail: "Offline and stale stations" },
              { label: "Partner workspace", href: "/admin/partners", detail: "Venues and applications" },
              { label: "Financial oversight", href: "/admin/finance", detail: "Payments and revenue" },
            ].map((item) => <Link key={item.href} href={item.href} className="group flex items-center gap-3 py-2.5"><span className="min-w-0 flex-1"><span className="block text-sm font-bold group-hover:text-forest">{item.label}</span><span className="block text-xs text-graphite">{item.detail}</span></span><span className="text-forest transition group-hover:translate-x-1">→</span></Link>)}
          </div>
        </section>
      </div>

      {/* Workflows — compact row */}
      <section aria-label="Workflows" className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
        {actions.map((route, i) => <Link key={route.href} href={route.href} className="group flex items-center gap-3 rounded-xl border border-[#dfe6df] bg-white px-4 py-3 transition hover:-translate-y-px hover:shadow"><span className="text-xs font-extrabold tracking-wider text-forest">{"0" + (i + 1)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{route.title}</span><span className="block truncate text-xs text-graphite">{route.detail}</span></span><span className="text-forest transition group-hover:translate-x-0.5" aria-hidden>↗</span></Link>)}
      </section>
    </div>
  </AdminGate>;
}
