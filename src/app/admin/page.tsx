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

function Stat({ label, value, detail, href }: { label: string; value: string; detail: string; href: string }) {
  return <Link href={href} className="group rounded-2xl border border-[#dfe6df] bg-white p-5 transition hover:-translate-y-0.5 hover:shadow-lg">
    <span className="text-[11px] font-extrabold uppercase tracking-[.14em] text-graphite">{label}</span>
    <span className="mt-3 block text-4xl font-bold tracking-tight text-ink">{value}</span>
    <span className="mt-2 flex items-center justify-between gap-2 text-xs text-graphite"><span>{detail}</span><span className="font-bold text-forest group-hover:translate-x-1">→</span></span>
  </Link>;
}

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
  const work = [
    { label: "Customer care", href: "/admin/support", description: "Triage and resolve conversations", icon: "↗" },
    { label: "Customer profiles", href: "/admin/customers", description: "One view of the person and their history", icon: "◎" },
    { label: "Network operations", href: "/admin/fleet", description: "Stations, rentals and service", icon: "▦" },
    { label: "Partner operations", href: "/admin/partners", description: "Venues, placements and payouts", icon: "⌁" },
    { label: "Financial control", href: "/admin/finance", description: "Payments and revenue oversight", icon: "◫" },
    { label: "Intelligence", href: "/admin/analytics", description: "Metrics and trends", icon: "◷" },
  ];
  return <AdminGate title="Operations workspace" nav="dashboard">
    <div className="space-y-7">
      <section className="overflow-hidden rounded-3xl bg-[#142126] px-6 py-8 text-white md:px-9 md:py-10">
        <div className="grid gap-8 xl:grid-cols-[1fr_390px] xl:items-end">
          <div>
            <p className="eyebrow text-lime">Internal command center</p>
            <h2 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight md:text-5xl">Good work starts with the right context.</h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-[#b7c8c2]">Find a customer, clear a case, or move directly into an operations workspace.</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link href="/admin/support?view=person" className="inline-flex min-h-11 items-center rounded-xl bg-lime px-5 text-sm font-bold text-ink hover:bg-white">Open priority inbox →</Link>
              <Link href="/admin/customers" className="inline-flex min-h-11 items-center rounded-xl border border-white/25 px-5 text-sm font-bold hover:bg-white/10">Browse customers</Link>
            </div>
          </div>
          <form method="get" action="/admin/customers" className="rounded-2xl border border-white/15 bg-white/10 p-5">
            <label htmlFor="command-customer" className="text-xs font-extrabold uppercase tracking-widest text-lime">Customer lookup</label>
            <p className="mt-1 text-xs text-[#b7c8c2]">Search name, email, phone, or rental reference.</p>
            <div className="mt-4 flex gap-2">
              <input id="command-customer" name="q" required minLength={2} placeholder="Who can we help?" className="min-h-11 min-w-0 flex-1 rounded-lg border border-white/20 bg-white px-3 text-sm text-ink outline-none" />
              <button className="rounded-lg bg-lime px-4 text-sm font-bold text-ink">Find</button>
            </div>
          </form>
        </div>
      </section>
      <section aria-label="Live operations" className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        <Stat label="Needs a person" value={metrics ? String(metrics.needsHuman) : "—"} detail="AI escalations" href="/admin/support?view=person" />
        <Stat label="Unassigned" value={metrics ? String(metrics.unassigned) : "—"} detail="Open conversations" href="/admin/support?view=unassigned" />
        <Stat label="Stations online" value={online} detail="Connected station status" href="/admin/fleet" />
        <Stat label="Rentals in progress" value={openRentals} detail="Active or dispensing" href="/admin/rentals" />
      </section>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,.6fr)]">
        <section className="overflow-hidden rounded-2xl border border-[#dfe6df] bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-mist px-6 py-5"><div><p className="eyebrow text-forest">Priority queue</p><h2 className="mt-1 text-xl font-bold">Cases to move forward</h2></div><Link href="/admin/support?view=person" className="text-sm font-bold text-forest hover:underline">View full inbox →</Link></div>
          {!ctx ? <p className="px-6 py-10 text-sm text-graphite">Support data is unavailable in this environment.</p> : queue.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No unassigned, urgent, or breached tickets in the current queue.</p> :
          <ul className="divide-y divide-mist">{queue.map((t) => <li key={t.id}><Link href={"/admin/support/" + t.number} className="flex flex-wrap items-center gap-3 px-6 py-4 hover:bg-[#f3f8ee]"><span className={t.priority === "urgent" ? "h-2.5 w-2.5 rounded-full bg-red-500" : "h-2.5 w-2.5 rounded-full bg-gold"} aria-hidden /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{t.subject || t.category}</span><span className="mt-1 block truncate text-xs text-graphite">{t.number} · {t.name} · {t.queue} · {t.state.replace(/_/g, " ")}</span></span><span className="text-xs text-graphite">{new Date(t.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span><span className="text-sm font-bold text-forest">→</span></Link></li>)}</ul>}
        </section>
        <section className="rounded-2xl border border-[#dfe6df] bg-white p-6">
          <p className="eyebrow text-forest">Navigate</p><h2 className="mt-1 text-xl font-bold">Workspaces</h2>
          <div className="mt-4 divide-y divide-mist">{work.map((item) => <Link key={item.href} href={item.href} className="flex items-center gap-3 py-3 hover:text-forest"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf3ea] text-lg font-bold">{item.icon}</span><span className="min-w-0 flex-1"><span className="block text-sm font-bold">{item.label}</span><span className="block text-xs text-graphite">{item.description}</span></span><span aria-hidden>→</span></Link>)}</div>
        </section>
      </div>
    </div>
  </AdminGate>;
}
