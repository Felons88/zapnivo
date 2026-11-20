export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate, ADMIN_TOOL_INDEX, icons } from "@/components/AdminShell";
import { getAdminStats, pick } from "@/lib/admin-stats";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";

export const metadata: Metadata = { title: "Zapnivo Ops", robots: { index: false, follow: false } };

const navy = "text-[#0a2540]";
const muted = "text-[#8898aa]";
const secondary = "text-[#425466]";
const accent = "text-[#635bff]";
const card = "rounded-xl border border-[#e3e8ee] bg-white shadow-[0_1px_3px_rgba(10,37,64,.05)]";

const TILES: { name: string; desc: string; href: string; icon: keyof typeof icons; badge?: "care" | "fleet" | "finance" }[] = [
  { name: "Mission Control", desc: "Live vitals, the priority queue, and trends", href: "/admin/overview", icon: "chart" },
  { name: "Customer Care", desc: "Inbox, refunds, inquiries, SMS, receptionist", href: "/admin/support?view=person", icon: "inbox", badge: "care" },
  { name: "Customers", desc: "Search accounts, rentals, wallet, history", href: "/admin/customers", icon: "users" },
  { name: "Fleet & Network", desc: "Stations, slots, inventory, maintenance", href: "/admin/fleet", icon: "battery", badge: "fleet" },
  { name: "Partners", desc: "Applications, venues, placements, agreements", href: "/admin/partners", icon: "store" },
  { name: "Finance", desc: "Revenue, payouts, disputes, investigations", href: "/admin/finance", icon: "coins", badge: "finance" },
  { name: "Growth", desc: "Analytics, forecasting, advertising", href: "/admin/analytics", icon: "steps" },
  { name: "Intelligence", desc: "AI ops, evals, knowledge, experiments", href: "/admin/ai-ops", icon: "chat" },
  { name: "System", desc: "Users, observability, audit log", href: "/admin/users", icon: "shield" },
];

export default async function AdminHome() {
  const [ctx, stats] = await Promise.all([defaultCtx(), getAdminStats()]);
  const metrics = ctx ? await computeMetrics(ctx.repo) : null;

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);

  const needsHuman = metrics?.needsHuman ?? 0;
  const fleetAttention = stats?.kioskStates == null ? 0 : pick(stats.kioskStates, "offline") + pick(stats.kioskStates, "stale");
  const refundsAwaiting = metrics?.refunds.requested ?? 0;
  const disputesOpen = stats?.disputesOpen ?? 0;
  const badges: Record<string, number> = {
    care: needsHuman,
    fleet: fleetAttention,
    finance: refundsAwaiting + disputesOpen,
  };

  const groups = [...new Set(ADMIN_TOOL_INDEX.map((t) => t.group))];

  return (
    <AdminGate title="Zapnivo Ops" nav="dashboard">
      <div className="mx-auto max-w-4xl">
        {/* ── Greeting ─────────────────────────────────────────────── */}
        <h1 className={`text-xl font-bold tracking-tight ${navy}`}>{greeting}</h1>
        <p className={`mt-0.5 text-sm ${secondary}`}>{today} · pick a workspace, or press <kbd className="rounded border border-[#e3e8ee] bg-white px-1 py-0.5 text-[10px] font-semibold text-[#425466]">⌘K</kbd> to jump anywhere.</p>

        {/* ── Search ───────────────────────────────────────────────── */}
        <form method="get" action="/admin/search" className="mt-5">
          <div className={`flex items-center gap-2.5 px-4 ${card} transition focus-within:border-[#635bff]`}>
            <span className="text-[#8898aa]">{icons.search}</span>
            <input name="q" aria-label="Search records and tools" placeholder="Search customers, tickets, rentals, stations, tools…" className="h-12 min-w-0 flex-1 bg-transparent text-sm text-[#0a2540] outline-none placeholder:text-[#8898aa]" />
            <button className="shrink-0 text-xs font-semibold text-[#635bff]">Search</button>
          </div>
        </form>

        {/* ── Needs-you banner ─────────────────────────────────────── */}
        {(needsHuman > 0 || fleetAttention > 0) && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-[#f5d9a8] bg-[#fffaf0] px-4 py-3">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-[#b25e09]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#df1b41]" />
              Needs you
            </p>
            {needsHuman > 0 && <Link href="/admin/support?view=person" className="text-[13px] font-medium text-[#425466] hover:text-[#635bff]">{needsHuman} case{needsHuman === 1 ? "" : "s"} waiting →</Link>}
            {fleetAttention > 0 && <Link href="/admin/fleet?state=attention" className="text-[13px] font-medium text-[#425466] hover:text-[#635bff]">{fleetAttention} station{fleetAttention === 1 ? "" : "s"} offline/stale →</Link>}
            {(refundsAwaiting + disputesOpen) > 0 && <Link href="/admin/disputes" className="text-[13px] font-medium text-[#425466] hover:text-[#635bff]">{refundsAwaiting + disputesOpen} money item{(refundsAwaiting + disputesOpen) === 1 ? "" : "s"} open →</Link>}
          </div>
        )}

        {/* ── App tiles ────────────────────────────────────────────── */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {TILES.map((t) => (
            <Link key={t.name} href={t.href} className={`group relative flex flex-col gap-3 p-4 ${card} transition hover:-translate-y-0.5 hover:border-[#c7cfda] hover:shadow-[0_8px_24px_rgba(10,37,64,.08)]`}>
              <span className="flex items-start justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#edeeff] text-[#635bff]">{icons[t.icon]}</span>
                {t.badge && badges[t.badge] > 0 ? (
                  <span className="rounded-full bg-[#ffe2e5] px-2 py-0.5 text-[11px] font-semibold text-[#df1b41]">{badges[t.badge]}</span>
                ) : null}
              </span>
              <span>
                <span className={`block text-[13px] font-semibold ${navy}`}>{t.name}</span>
                <span className={`mt-0.5 block text-xs leading-5 ${muted}`}>{t.desc}</span>
              </span>
              <span aria-hidden className={`absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold ${accent} opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100`}>→</span>
            </Link>
          ))}
        </div>

        {/* ── Everything index ─────────────────────────────────────── */}
        <section aria-labelledby="all-tools" className="mt-8">
          <h2 id="all-tools" className={`text-[11px] font-semibold uppercase tracking-[.14em] ${muted}`}>Everything</h2>
          <div className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            {groups.map((g) => (
              <div key={g}>
                <p className={`text-[11px] font-semibold uppercase tracking-wider ${muted}`}>{g}</p>
                <ul className="mt-1.5 space-y-0.5">
                  {ADMIN_TOOL_INDEX.filter((t) => t.group === g).map((t) => (
                    <li key={t.href}>
                      <Link href={t.href} className={`-mx-1 block rounded px-1 py-0.5 text-[13px] ${secondary} transition hover:bg-[#edeeff] hover:text-[#635bff]`}>{t.label}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
    </AdminGate>
  );
}
