export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate, ADMIN_TOOL_INDEX, icons } from "@/components/AdminShell";
import { LauncherGrid, type LauncherTile } from "@/components/LauncherGrid";
import { getAdminStats, pick } from "@/lib/admin-stats";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";

export const metadata: Metadata = { title: "Zapnivo Ops", robots: { index: false, follow: false } };

/* Lovable "Command Center" module model (opscenter/src/lib/modules.ts) mapped to
   the real admin routes. Tones = the exact oklch tile palette from its theme. */
const TONE = {
  blue: "oklch(0.56 0.2 259)",
  teal: "oklch(0.6 0.11 190)",
  amber: "oklch(0.72 0.15 70)",
  rose: "oklch(0.6 0.18 15)",
  green: "oklch(0.6 0.14 155)",
  slate: "oklch(0.42 0.03 262)",
  cyan: "oklch(0.65 0.12 225)",
  orange: "oklch(0.66 0.17 45)",
  indigo: "oklch(0.5 0.15 270)",
} as const;

const MODULES: Omit<LauncherTile, "badge">[] = [
  { id: "overview", name: "Mission Control", blurb: "Revenue, rentals, fleet and live activity", href: "/admin/overview", shortcut: "o", color: TONE.blue, icon: icons.activity,
    sections: [{ label: "Summary", href: "/admin/overview" }, { label: "Alerts", href: "/admin/support?view=person" }, { label: "Search all", href: "/admin/search" }] },
  { id: "venues", name: "Venue CRM", blurb: "Venues, owners, prospects and outreach", href: "/admin/partners", shortcut: "v", color: TONE.teal, icon: icons.building,
    sections: [{ label: "Directory", href: "/admin/partners" }, { label: "Pipeline", href: "/admin/opportunities" }, { label: "Placements", href: "/admin/placements" }, { label: "Agreements", href: "/admin/agreements" }] },
  { id: "kiosks", name: "Kiosk Fleet", blurb: "Heartbeats, docks, telemetry and commands", href: "/admin/fleet", shortcut: "k", color: TONE.cyan, icon: icons.cpu,
    sections: [{ label: "Fleet", href: "/admin/fleet" }, { label: "Equipment", href: "/admin/equipment" }, { label: "Restocking", href: "/admin/restock" }] },
  { id: "rentals", name: "Rentals", blurb: "Active, overdue and completed rentals", href: "/admin/rentals", shortcut: "r", color: TONE.amber, icon: icons.timer,
    sections: [{ label: "All rentals", href: "/admin/rentals" }, { label: "Disputes", href: "/admin/disputes" }, { label: "Events", href: "/admin/events" }] },
  { id: "payments", name: "Payments & Finance", blurb: "Charges, refunds, revenue shares, payouts", href: "/admin/finance", shortcut: "p", color: TONE.green, icon: icons.coins,
    sections: [{ label: "Revenue", href: "/admin/finance" }, { label: "Payouts", href: "/admin/payouts" }, { label: "Refunds", href: "/admin/support/refunds" }, { label: "Exceptions", href: "/admin/revenue" }] },
  { id: "support", name: "Support Center", blurb: "Inbox, cases, macros and adjustments", href: "/admin/support", shortcut: "s", color: TONE.rose, icon: icons.inbox,
    sections: [{ label: "Inbox", href: "/admin/support" }, { label: "Customer lookup", href: "/admin/customers" }, { label: "Refunds", href: "/admin/support/refunds" }, { label: "Metrics", href: "/admin/support/metrics" }] },
  { id: "access", name: "Users & Access", blurb: "Staff, customers, sessions and roles", href: "/admin/users", shortcut: "u", color: TONE.slate, icon: icons.users,
    sections: [{ label: "Staff", href: "/admin/users" }, { label: "Customers", href: "/admin/customers" }, { label: "Audit", href: "/admin/audit" }] },
  { id: "notifications", name: "Notifications", blurb: "Templates, events, delivery and previews", href: "/admin/notifications", shortcut: "n", color: TONE.orange, icon: icons.bell,
    sections: [{ label: "Templates", href: "/admin/notifications" }, { label: "Delivery log", href: "/admin/notifications" }, { label: "Email studio", href: "/admin/email-studio" }, { label: "SMS log", href: "/admin/sms" }] },
  { id: "growth", name: "Marketing & Growth", blurb: "Campaigns, attribution and conversion", href: "/admin/analytics", shortcut: "m", color: TONE.indigo, icon: icons.megaphone,
    sections: [{ label: "Analytics", href: "/admin/analytics" }, { label: "Advertising", href: "/admin/advertising" }, { label: "Forecasting", href: "/admin/forecasting" }, { label: "Experiments", href: "/admin/experiments" }] },
  { id: "automation", name: "Automation Studio", blurb: "Workflows, approvals, retries and runs", href: "/admin/ai-ops", shortcut: "a", color: TONE.blue, icon: icons.steps,
    sections: [{ label: "AI operations", href: "/admin/ai-ops" }, { label: "Eval lab", href: "/admin/evals" }, { label: "Knowledge", href: "/admin/knowledge" }] },
  { id: "operations", name: "Field Operations", blurb: "Inventory, tickets, technicians, routes", href: "/admin/vending-ops", shortcut: "f", color: TONE.amber, icon: icons.boxes,
    sections: [{ label: "Vending ops", href: "/admin/vending-ops" }, { label: "Inventory", href: "/admin/inventory" }, { label: "Restocking", href: "/admin/restock" }] },
  { id: "system", name: "System & Settings", blurb: "Diagnostics, flags, audit, health", href: "/admin/observability", shortcut: "y", color: TONE.slate, icon: icons.shield,
    sections: [{ label: "Observability", href: "/admin/observability" }, { label: "Audit log", href: "/admin/audit" }, { label: "Events", href: "/admin/events" }] },
];

const navy = "text-[#0a2540]";
const muted = "text-[#8898aa]";
const secondary = "text-[#425466]";
const card = "rounded-xl border border-[#e3e8ee] bg-white shadow-[0_1px_3px_rgba(10,37,64,.05)]";

export default async function AdminHome() {
  const [ctx, stats] = await Promise.all([defaultCtx(), getAdminStats()]);
  const metrics = ctx ? await computeMetrics(ctx.repo) : null;

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);

  /* Real badge counts — zero renders as nothing, matching Lovable's honest-empty rule. */
  const needsHuman = metrics?.needsHuman ?? 0;
  const fleetAttention = stats?.kioskStates == null ? 0 : pick(stats.kioskStates, "offline") + pick(stats.kioskStates, "stale");
  const moneyOpen = (metrics?.refunds.requested ?? 0) + (stats?.disputesOpen ?? 0);
  const appsPending = stats?.applicationStates == null ? 0 : pick(stats.applicationStates, "pending");
  const badges: Record<string, number> = {
    support: needsHuman,
    kiosks: fleetAttention,
    payments: moneyOpen,
    venues: appsPending,
  };
  const tiles: LauncherTile[] = MODULES.map((m) => ({ ...m, badge: badges[m.id] || undefined }));

  const groups = [...new Set(ADMIN_TOOL_INDEX.map((t) => t.group))];

  return (
    <AdminGate title="Command center" nav="dashboard">
      {/* Full-bleed Lovable backdrop — breaks out of the shell's content padding */}
      <div className="admin-launcher relative -mx-5 -mt-5 min-h-[calc(100vh-120px)] px-5 pb-10 pt-7 md:-mx-8 md:px-8">
        <div aria-hidden className="launcher-dots pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-5xl">
          {/* ── Greeting ─────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className={`text-xl font-bold tracking-tight ${navy}`}>{greeting}</h1>
              <p className={`mt-0.5 text-sm ${secondary}`}>
                {today} · pick a workspace — or press a key (<kbd className="rounded border border-[#e3e8ee] bg-white px-1 py-0.5 text-[10px] font-semibold text-[#425466]">o</kbd>{" "}
                <kbd className="rounded border border-[#e3e8ee] bg-white px-1 py-0.5 text-[10px] font-semibold text-[#425466]">s</kbd>{" "}
                <kbd className="rounded border border-[#e3e8ee] bg-white px-1 py-0.5 text-[10px] font-semibold text-[#425466]">k</kbd>…) or{" "}
                <kbd className="rounded border border-[#e3e8ee] bg-white px-1 py-0.5 text-[10px] font-semibold text-[#425466]">⌘K</kbd> to jump anywhere.
              </p>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#8898aa]">
              <span aria-hidden className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#0e6245]" /> Live
            </p>
          </div>

          {/* ── Search ───────────────────────────────────────────────── */}
          <form method="get" action="/admin/search" className="mt-5">
            <div className={`flex items-center gap-2.5 px-4 ${card} transition focus-within:border-[#635bff]`}>
              <span className="text-[#8898aa]">{icons.search}</span>
              <input name="q" aria-label="Search records and tools" placeholder="Search customers, tickets, rentals, stations, tools…" className="h-12 min-w-0 flex-1 bg-transparent text-sm text-[#0a2540] outline-none placeholder:text-[#8898aa]" />
              <button className="shrink-0 text-xs font-semibold text-[#635bff]">Search</button>
            </div>
          </form>

          {/* ── Needs-you banner ─────────────────────────────────────── */}
          {(needsHuman > 0 || fleetAttention > 0 || moneyOpen > 0) && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-[#f5d9a8] bg-[#fffaf0] px-4 py-3">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-[#b25e09]">
                <span aria-hidden className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#df1b41]" />
                Needs you
              </p>
              {needsHuman > 0 && <Link href="/admin/support?view=person" className="text-[13px] font-medium text-[#425466] hover:text-[#635bff]">{needsHuman} case{needsHuman === 1 ? "" : "s"} waiting →</Link>}
              {fleetAttention > 0 && <Link href="/admin/fleet?state=attention" className="text-[13px] font-medium text-[#425466] hover:text-[#635bff]">{fleetAttention} station{fleetAttention === 1 ? "" : "s"} offline/stale →</Link>}
              {moneyOpen > 0 && <Link href="/admin/disputes" className="text-[13px] font-medium text-[#425466] hover:text-[#635bff]">{moneyOpen} money item{moneyOpen === 1 ? "" : "s"} open →</Link>}
            </div>
          )}

          {/* ── Module launcher ──────────────────────────────────────── */}
          <div className="mt-5">
            <LauncherGrid tiles={tiles} />
          </div>

          {/* ── Everything index ─────────────────────────────────────── */}
          <section aria-labelledby="all-tools" className="mt-10">
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
      </div>
    </AdminGate>
  );
}
