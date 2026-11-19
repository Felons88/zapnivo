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

const arrow = <span aria-hidden>↗</span>;

function Signal({ label, value, detail, href, accent = "plain" }: { label: string; value: string; detail: string; href: string; accent?: "plain" | "urgent" | "lime" }) {
  return <Link href={href} className={"group flex min-h-44 flex-col justify-between rounded-2xl border p-5 transition hover:-translate-y-0.5 hover:shadow-lg " + (accent === "urgent" ? "border-[#f0d7cb] bg-[#fff8f3]" : accent === "lime" ? "border-[#dce9ba] bg-[#f2f9e7]" : "border-[#dfe6df] bg-white")}>
    <span className="flex items-start justify-between gap-3"><span className="text-[11px] font-extrabold uppercase tracking-[.14em] text-graphite">{label}</span><span className="text-forest transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5">{arrow}</span></span>
    <span><span className="block text-4xl font-bold tracking-tight text-ink">{value}</span><span className="mt-1 block text-xs text-graphite">{detail}</span></span>
  </Link>;
}

const routes = [
  { index: "01", title: "Resolve a customer issue", detail: "Triage the queue, read the full history, and reply from the case.", href: "/admin/support?view=person", tone: "bg-[#f3f7ed]" },
  { index: "02", title: "Find a customer", detail: "Search a person, rental, ticket, or reference across the workspace.", href: "/admin/search", tone: "bg-[#eef5f5]" },
  { index: "03", title: "Investigate a station", detail: "Review fleet health, slot readiness, and the station timeline.", href: "/admin/fleet?state=attention", tone: "bg-[#f7f3ec]" },
  { index: "04", title: "Handle incoming contact", detail: "Route email and SMS conversations to the right next step.", href: "/admin/receptionist", tone: "bg-[#f2f0f8]" },
] as const;

export default async function AdminDashboard() {
  const [ctx, stats] = await Promise.all([defaultCtx(), getAdminStats()]);
  const [metrics, tickets] = ctx ? await Promise.all([computeMetrics(ctx.repo), ctx.repo.listTickets({ limit: 250 })]) : [null, [] as Ticket[]];
  const now = new Date();
  const attention = tickets.filter((t) => t.state !== "resolved" && t.state !== "closed" && t.aiState !== "ai_active"
    && (t.priority === "urgent" || !t.assignedTo || slaStatus(t, now).firstResponse === "breached"));
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  attention.sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt));
  const queue = attention.slice(0, 5);
  const kioskTotal = total(stats?.kioskStates);
  const online = stats?.kioskStates == null ? "—" : String(pick(stats.kioskStates, "online")) + " / " + String(kioskTotal);
  const openRentals = stats?.rentalStates == null ? "—" : String(pick(stats.rentalStates, "active") + pick(stats.rentalStates, "dispense_pending"));
  const unresolved = metrics ? String(metrics.needsHuman) : "—";
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);

  return <AdminGate title="Operations workspace" nav="dashboard">
    <div className="space-y-7">
      <section className="relative isolate overflow-hidden rounded-[28px] bg-[#101d22] px-6 py-8 text-white md:px-9 md:py-10">
        <div aria-hidden className="pointer-events-none absolute -right-28 -top-36 h-96 w-96 rounded-full border border-lime/20 shadow-[0_0_0_60px_rgba(217,255,115,.04),0_0_0_120px_rgba(217,255,115,.025)]" />
        <div className="relative grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-end">
          <div>
            <p className="eyebrow text-lime">Your command center · {today}</p>
            <h2 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.05] tracking-[-.045em] md:text-5xl">See the work.<br /><span className="text-lime">Move it forward.</span></h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-[#c3d0cd]">Start with the queue, find the person behind an issue, and move into the right operational workspace.</p>
            <div className="mt-7 flex flex-wrap gap-2">
              <Link href="/admin/support?view=person" className="inline-flex min-h-11 items-center rounded-xl bg-lime px-5 text-sm font-bold text-ink hover:bg-white">Work the priority queue →</Link>
              <Link href="/admin/inquiries" className="inline-flex min-h-11 items-center rounded-xl border border-white/30 px-5 text-sm font-bold hover:bg-white/10">Review new inquiries</Link>
            </div>
          </div>
          <form method="get" action="/admin/search" className="rounded-2xl border border-white/20 bg-white/10 p-5 backdrop-blur">
            <label htmlFor="command-search" className="text-xs font-extrabold uppercase tracking-widest text-lime">Find anything</label>
            <p className="mt-2 text-xs leading-5 text-[#c3d0cd]">Customer, email, phone, ticket, rental reference, or tool.</p>
            <div className="mt-4 flex gap-2">
              <input id="command-search" name="q" required minLength={2} placeholder="Search the workspace" className="min-h-11 min-w-0 flex-1 rounded-lg border border-white/20 bg-white px-3 text-sm text-ink outline-none" />
              <button className="rounded-lg bg-lime px-4 text-sm font-bold text-ink">Search</button>
            </div>
          </form>
        </div>
      </section>

      <section aria-labelledby="pulse-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><p className="eyebrow text-forest">Live pulse</p><h2 id="pulse-title" className="mt-1 text-2xl font-bold tracking-tight">What needs attention</h2></div><span className="text-xs text-graphite">Live source data · unavailable values show —</span></div>
        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
          <Signal label="Needs a person" value={unresolved} detail="Support conversations escalated to staff" href="/admin/support?view=person" accent="urgent" />
          <Signal label="Unassigned" value={metrics ? String(metrics.unassigned) : "—"} detail="Open conversations without an owner" href="/admin/support?view=unassigned" />
          <Signal label="Stations online" value={online} detail="Connected stations across the fleet" href="/admin/fleet" accent="lime" />
          <Signal label="Rentals in progress" value={openRentals} detail="Active or dispensing now" href="/admin/rentals" />
        </div>
      </section>

      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.45fr)_minmax(310px,.55fr)]">
        <section aria-labelledby="queue-title" className="overflow-hidden rounded-2xl border border-[#dfe6df] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-mist px-6 py-5"><div><p className="eyebrow text-forest">Start here</p><h2 id="queue-title" className="mt-1 text-xl font-bold">Priority case queue</h2></div><Link href="/admin/support?view=person" className="text-sm font-bold text-forest hover:underline">Open full inbox →</Link></div>
          {!ctx ? <p className="px-6 py-10 text-sm text-graphite">Support data is unavailable in this environment.</p> : queue.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No unassigned, urgent, or breached cases in the current queue.</p> :
            <ul className="divide-y divide-mist">{queue.map((t) => <li key={t.id}><Link href={"/admin/support/" + t.number} className="group flex items-center gap-4 px-6 py-4 hover:bg-[#f4f8ef]"><span className={"h-10 w-1 shrink-0 rounded-full " + (t.priority === "urgent" ? "bg-red-500" : "bg-gold")} aria-hidden /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{t.subject || t.category}</span><span className="mt-1 block truncate text-xs text-graphite">{t.number} · {t.name} · {t.queue}</span></span><span className="hidden rounded-full bg-mist px-2.5 py-1 text-[11px] font-bold capitalize text-graphite sm:block">{t.state.replace(/_/g, " ")}</span><span className="text-sm font-bold text-forest transition group-hover:translate-x-1">→</span></Link></li>)}</ul>}
        </section>
        <section aria-labelledby="actions-title" className="rounded-2xl border border-[#dfe6df] bg-white p-6 shadow-sm">
          <p className="eyebrow text-forest">Jump back in</p><h2 id="actions-title" className="mt-1 text-xl font-bold">Daily actions</h2>
          <div className="mt-4 divide-y divide-mist">
            {[
              { label: "Customer profiles", href: "/admin/customers", detail: "History, rentals, cases" },
              { label: "Email and SMS desk", href: "/admin/receptionist", detail: "Incoming conversations" },
              { label: "Fleet attention", href: "/admin/fleet?state=attention", detail: "Offline and stale stations" },
              { label: "Partner workspace", href: "/admin/partners", detail: "Venues and applications" },
              { label: "Financial oversight", href: "/admin/finance", detail: "Payments and revenue" },
            ].map((item) => <Link key={item.href} href={item.href} className="group flex items-center gap-3 py-3"><span className="min-w-0 flex-1"><span className="block text-sm font-bold group-hover:text-forest">{item.label}</span><span className="block text-xs text-graphite">{item.detail}</span></span><span className="text-forest transition group-hover:translate-x-1">→</span></Link>)}
          </div>
        </section>
      </div>

      <section aria-labelledby="flow-title">
        <div className="mb-4"><p className="eyebrow text-forest">Workflows</p><h2 id="flow-title" className="mt-1 text-2xl font-bold tracking-tight">Choose the next move</h2></div>
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">{routes.map((route) => <Link key={route.index} href={route.href} className={"group flex min-h-52 flex-col justify-between rounded-2xl border border-[#dfe6df] p-5 transition hover:-translate-y-0.5 hover:shadow-md " + route.tone}><span className="flex items-start justify-between"><span className="text-xs font-extrabold tracking-wider text-forest">{route.index}</span><span className="transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5">{arrow}</span></span><span><span className="block text-lg font-bold leading-tight">{route.title}</span><span className="mt-2 block text-xs leading-5 text-graphite">{route.detail}</span></span></Link>)}</div>
      </section>

      <section aria-label="Network and intake summary" className="grid gap-3 md:grid-cols-3">
        <Signal label="Inquiries to review" value={stats?.unhandledContacts == null ? "—" : String(stats.unhandledContacts)} detail="Website messages awaiting handling" href="/admin/inquiries" />
        <Signal label="Rentals started today" value={stats?.rentalsToday == null ? "—" : String(stats.rentalsToday)} detail="New rental records in the last 24 hours" href="/admin/rentals" />
        <Signal label="Slots ready" value={stats?.slotStates == null ? "—" : String(pick(stats.slotStates, "ready")) + " / " + String(total(stats.slotStates))} detail="Reported ready across registered slots" href="/admin/fleet" />
      </section>
    </div>
  </AdminGate>;
}
