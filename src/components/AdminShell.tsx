import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { authConfigured, devAuth, getSessionUser, isStaff, SESSION_COOKIE } from "@/lib/auth";
import { LogoutButton } from "./LogoutButton";
import { LiveSync } from "./LiveSync";
import { Notice } from "./ui";
import { SITE } from "@/lib/site";
import { getPublishedContent, flag, text as cmsText } from "@/lib/site-content";

/** Staff-visible tables in the realtime publication — any change refreshes the open page. */
const LIVE_TABLES = [
  "rentals", "payments", "support_tickets", "support_messages", "refund_requests",
  "disputes", "incident_reports", "customer_notes", "customer_data_requests",
  "sms_messages", "profiles", "entitlement_grants", "wallet_topups",
];

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const I = ({ children, className = "h-[18px] w-[18px] shrink-0" }: { children: ReactNode; className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className} {...stroke}>{children}</svg>
);

const icons = {
  dashboard: <I><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></I>,
  inbox: <I><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.5 2 12v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5l-3.5-6.5A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.5Z" /></I>,
  building: <I><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 21v-4h6v4" /><path d="M9 7h1m4 0h1M9 11h1m4 0h1" /></I>,
  shield: <I><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" /><path d="M12 8v4" /><path d="M12 15h.01" /></I>,
  coins: <I><circle cx="12" cy="12" r="9" /><path d="M15.5 9.5c-.8-.8-2-1.3-3.5-1.3-2 0-3.5 1-3.5 2.4 0 3.2 7 1.6 7 4.8 0 1.4-1.5 2.4-3.5 2.4-1.5 0-2.7-.5-3.5-1.3" /><path d="M12 6.5v1.7m0 7.6v1.7" /></I>,
  chart: <I><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M8 17v-6m5 6V7m5 10v-3" /></I>,
  battery: <I><rect x="2" y="7" width="17" height="10" rx="2" /><path d="M22 11v2" /><path d="m11 9-2 3h3l-2 3" /></I>,
  swap: <I><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></I>,
  store: <I><path d="M4 10v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V10" /><path d="M3 6.5 5 3h14l2 3.5a3 3 0 0 1-6 .5 3 3 0 0 1-6 0 3 3 0 0 1-6-.5Z" /><path d="M9 21v-6h6v6" /></I>,
  megaphone: <I><path d="m3 11 18-5v12L3 13v-2Z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" /></I>,
  users: <I><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" /></I>,
  scroll: <I><path d="M8 3h11v14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-1h13" /><path d="M8 8h6M8 12h6" /></I>,
  mail: <I><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></I>,
  steps: <I><path d="M4 19V9m6 10V5m6 14v-7" /><path d="M3 19h18" /></I>,
  clock: <I><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>,
  chat: <I><path d="M21 12a9 9 0 1 1-9-9" /><path d="M8.5 14a5 5 0 0 0 7 0" /></I>,
  tag: <I><path d="M3 12V4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="8.5" r="1" /></I>,
  alert: <I><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></I>,
  search: <I><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></I>,
} satisfies Record<string, ReactNode>;

export type AdminNavKey = keyof typeof NAV_ITEMS;

const NAV_ITEMS = {
  dashboard: { href: "/admin", label: "Dashboard", icon: icons.dashboard, group: "Overview" },
  search: { href: "/admin/search", label: "Search all", icon: icons.search, group: "Overview" },
  analytics: { href: "/admin/analytics", label: "Analytics", icon: icons.chart, group: "Growth" },
  forecasting: { href: "/admin/forecasting", label: "Forecasting", icon: icons.chart, group: "Growth" },
  opportunities: { href: "/admin/opportunities", label: "Opportunities", icon: icons.chart, group: "Growth" },
  inbox: { href: "/admin/support", label: "Inbox", icon: icons.inbox, group: "Customer care" },
  customers: { href: "/admin/customers", label: "Customers", icon: icons.users, group: "Customer care" },
  partner: { href: "/admin/support?queue=partner", label: "Partner relations", icon: icons.building, group: "Partners" },
  safety: { href: "/admin/support?queue=safety", label: "Safety", icon: icons.shield, group: "Customer care" },
  refunds: { href: "/admin/support/refunds", label: "Refunds", icon: icons.coins, group: "Customer care" },
  metrics: { href: "/admin/support/metrics", label: "Support metrics", icon: icons.chart, group: "Customer care" },
  inquiries: { href: "/admin/inquiries", label: "Inquiries", icon: icons.mail, group: "Customer care" },
  receptionist: { href: "/admin/receptionist", label: "AI receptionist", icon: icons.chat, group: "Customer care" },
  sms: { href: "/admin/sms", label: "SMS log", icon: icons.chat, group: "Customer care" },
  notifications: { href: "/admin/notifications", label: "Notifications", icon: icons.alert, group: "Customer care" },
  emailStudio: { href: "/admin/email-studio", label: "Email studio", icon: icons.mail, group: "Customer care" },
  fleet: { href: "/admin/fleet", label: "Fleet", icon: icons.battery, group: "Network" },
  profitability: { href: "/admin/profitability", label: "Profitability", icon: icons.coins, group: "Network" },
  vendingOps: { href: "/admin/vending-ops", label: "Vending ops", icon: icons.chart, group: "Network" },
  placements: { href: "/admin/placements", label: "Placements", icon: icons.steps, group: "Partners" },
  equipment: { href: "/admin/equipment", label: "Equipment", icon: icons.battery, group: "Network" },
  inventory: { href: "/admin/inventory", label: "Inventory", icon: icons.battery, group: "Network" },
  restock: { href: "/admin/restock", label: "Restocking", icon: icons.swap, group: "Network" },
  agreements: { href: "/admin/agreements", label: "Agreements", icon: icons.scroll, group: "Partners" },
  rentals: { href: "/admin/rentals", label: "Rentals", icon: icons.swap, group: "Network" },
  memberships: { href: "/admin/memberships", label: "Memberships", icon: icons.users, group: "Commerce" },
  gifts: { href: "/admin/gifts", label: "Gifts", icon: icons.tag, group: "Commerce" },
  events: { href: "/admin/events", label: "Events", icon: icons.steps, group: "Commerce" },
  partners: { href: "/admin/partners", label: "Partners", icon: icons.store, group: "Partners" },
  onboarding: { href: "/admin/onboarding", label: "Onboarding", icon: icons.steps, group: "Partners" },
  sla: { href: "/admin/sla", label: "Partner SLA", icon: icons.clock, group: "Partners" },
  advertising: { href: "/admin/advertising", label: "Advertising", icon: icons.megaphone, group: "Growth" },
  demo: { href: "/admin/demo", label: "Demo preview", icon: icons.dashboard, group: "Commerce" },
  payouts: { href: "/admin/payouts", label: "Ledgers & payouts", icon: icons.coins, group: "Finance" },
  finance: { href: "/admin/finance", label: "Revenue", icon: icons.chart, group: "Finance" },
  revenueAssurance: { href: "/admin/revenue", label: "Revenue assurance", icon: icons.alert, group: "Finance" },
  promos: { href: "/admin/promos", label: "Promo codes", icon: icons.tag, group: "Finance" },
  disputes: { href: "/admin/disputes", label: "Disputes", icon: icons.alert, group: "Finance" },
  investigations: { href: "/admin/finance/investigations", label: "Investigations", icon: icons.scroll, group: "Finance" },
  users: { href: "/admin/users", label: "Users & roles", icon: icons.users, group: "System" },
  observability: { href: "/admin/observability", label: "Observability", icon: icons.alert, group: "System" },
  audit: { href: "/admin/audit", label: "Audit log", icon: icons.scroll, group: "System" },
  aiOps: { href: "/admin/ai-ops", label: "AI operations", icon: icons.chat, group: "Intelligence" },
  evals: { href: "/admin/evals", label: "Eval lab", icon: icons.chart, group: "Intelligence" },
  knowledge: { href: "/admin/knowledge", label: "Knowledge", icon: icons.scroll, group: "Intelligence" },
  experiments: { href: "/admin/experiments", label: "Experiments", icon: icons.steps, group: "Intelligence" },
} as const;

export const ADMIN_TOOL_INDEX = Object.values(NAV_ITEMS).map(({ group, label, href }) => ({ group, label, href }));

const GROUPS = ["Customer care", "Network", "Partners", "Commerce", "Growth", "Finance", "Intelligence", "System"] as const;
/** Daily destinations — everything else lives behind "All tools". */
const PRIMARY: AdminNavKey[] = ["dashboard", "inbox", "customers", "receptionist", "fleet", "partners", "finance"];
const MOBILE_PRIMARY: AdminNavKey[] = ["dashboard", "inbox", "customers", "fleet"];

/** Compact pill used in the topbar nav row. */
function TopLink({ item, active }: { item: (typeof NAV_ITEMS)[AdminNavKey]; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
        active ? "bg-[#0a2540] text-white" : "text-[#425466] hover:bg-[#eef1f5] hover:text-[#0a2540]"
      }`}
    >
      {item.label}
    </Link>
  );
}

/** Inline tools directory for the "All tools" dropdown (desktop only). */
function ToolsMenu({ all, nav }: { all: [AdminNavKey, (typeof NAV_ITEMS)[AdminNavKey]][]; nav: AdminNavKey }) {
  return (
    <details className="group relative">
      <summary className="flex shrink-0 cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-[#425466] hover:bg-[#eef1f5] hover:text-[#0a2540] [&::-webkit-details-marker]:hidden">
        All tools<span aria-hidden className="text-[10px] transition-transform group-open:rotate-180">▾</span>
      </summary>
      <div className="absolute left-0 top-full z-40 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-[#e3e8ee] bg-white p-2 shadow-[0_15px_35px_rgba(10,37,64,.12)]">
        {GROUPS.map((g) => {
          const items = all.filter(([key, item]) => item.group === g && !(PRIMARY as readonly string[]).includes(key));
          if (items.length === 0) return null;
          return (
            <div key={g} className="mb-1 last:mb-0">
              <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[#8898aa]">{g}</p>
              <div className="grid grid-cols-1 gap-0.5">
                {items.map(([key, item]) => (
                  <Link key={key} href={item.href} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] font-medium ${nav === key ? "bg-[#edeeff] text-[#635bff]" : "text-[#0a2540] hover:bg-[#f6f9fc]"}`}>
                    <span className="text-[#8898aa]">{item.icon}</span>{item.label}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function NavLink({ item, active, mobile = false }: { item: (typeof NAV_ITEMS)[AdminNavKey]; active: boolean; mobile?: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-10 items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors ${
        active ? "bg-[#edeeff] text-[#635bff]" : "text-[#425466] hover:bg-[#eef1f5] hover:text-[#0a2540]"
      }`}
    >
      <span className={active ? "text-[#635bff]" : "text-[#8898aa]"}>{item.icon}</span>
      {item.label}
    </Link>
  );
}

/**
 * Staff-console gate + dashboard chrome: fixed sidebar, sticky topbar, grouped nav.
 * Same auth rules as PortalGate — unauthenticated → /login, non-staff → /partners.
 */
export async function AdminGate({ title, nav, children }: { title: string; nav: AdminNavKey; children: ReactNode }) {
  if (!authConfigured()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-xl">
          <p className="eyebrow text-forest">Operations</p>
          <h1 className="display-md mt-4">{title}</h1>
          <div className="mt-8 text-left"><Notice title="Not configured yet.">
            Authentication isn't connected in this environment. Set <code>NEXT_PUBLIC_SUPABASE_URL</code>,
            <code> NEXT_PUBLIC_SUPABASE_ANON_KEY</code> and <code> SUPABASE_SERVICE_ROLE_KEY</code> (see .env.example),
            then apply the migrations in <code>supabase/migrations</code>.
          </Notice></div>
        </div>
      </div>
    );
  }
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user)) redirect("/partners");

  const accessToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const all = Object.entries(NAV_ITEMS) as [AdminNavKey, (typeof NAV_ITEMS)[AdminNavKey]][];
  const related = all.filter(([key, item]) => item.group === NAV_ITEMS[nav].group && key !== nav && !["dashboard", "search"].includes(key)).slice(0, 5);
  // CMS announcement banner (internal/global) — cached read, off unless enabled.
  const cms = await getPublishedContent("internal", "global");
  const announcement = flag(cms, "announcement_enabled", false)
    ? { text: cmsText(cms, "announcement_text", ""), href: cmsText(cms, "announcement_href", "") || undefined }
    : null;
  return (
    <div className="admin-console min-h-screen bg-[#f6f9fc] text-ink">
      <LiveSync channel="admin-live" tables={LIVE_TABLES} intervalMs={30000} accessToken={accessToken} />
      {devAuth() && (
        <div className="relative z-50 bg-gold px-4 py-2 text-center text-xs font-bold text-ink">
          DEV STORE · not real data · acting as <b>{user.email}</b> ({user.role}) — switch:{" "}
          {(["admin", "admin2", "agent", "partner"] as const).map((r) => <a key={r} href={`/api/dev/as?role=${r}&back=/${r === "partner" ? "partners/support" : "admin/support"}`} className="mx-1 underline">{r}</a>)}
        </div>
      )}

      {announcement?.text ? (
        <div className="border-b border-[#d8d0ff] bg-[#edeeff] px-5 py-2 text-center text-xs font-bold text-[#0a2540]">
          {announcement.text}
          {announcement.href ? <> · <Link href={announcement.href} className="underline underline-offset-2">Learn more →</Link></> : null}
        </div>
      ) : null}
      {/* Topbar — brand, search, user; one slim nav row underneath */}
      <header className="sticky top-0 z-30 border-b border-[#e3e8ee] bg-white/95 shadow-[0_1px_3px_rgba(10,37,64,.05)] backdrop-blur">
        <div className="flex h-14 items-center gap-4 px-5 md:px-8">
          <Link href="/admin" aria-label="Zapnivo internal" className="flex shrink-0 items-center gap-2">
            <span className="text-lg font-black tracking-tight text-[#0a2540]">zapnivo<span className="text-[#635bff]">.</span></span>
            <span className="rounded-md bg-[#edeeff] px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-widest text-[#635bff]">Ops</span>
          </Link>
          <form action="/admin/search" className="hidden min-w-0 flex-1 items-center gap-2 sm:flex sm:max-w-md">
            <span className="text-[#8898aa]">{icons.search}</span>
            <input name="q" aria-label="Search internal records and tools" placeholder="Search records and tools" className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-[#8898aa]" />
            <button type="submit" className="shrink-0 text-xs font-bold text-[#635bff]">Search</button>
          </form>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden min-w-0 text-right lg:block">
              <span className="block text-[10px] font-semibold uppercase leading-4 tracking-[.16em] text-[#8898aa]">{NAV_ITEMS[nav].group}</span>
              <span className="block truncate font-display text-sm font-bold tracking-tight text-[#0a2540]">{title}</span>
            </span>
            <Link href="/admin/support?view=person" className="hidden min-h-9 items-center rounded-lg bg-[#635bff] px-4 text-xs font-semibold text-white hover:bg-[#5851ea] md:inline-flex">Open work queue →</Link>
            <span className="hidden max-w-[180px] truncate text-xs font-medium text-[#425466] xl:block">{user.email}</span>
            <div className="lg:hidden"><LogoutButton light /></div>
            <div className="hidden lg:block"><LogoutButton light /></div>
          </div>
        </div>
        {/* Desktop nav row — daily destinations + full tools directory */}
        <nav aria-label="Console" className="hidden border-t border-[#eef1f5] lg:block">
          <div className="mx-auto flex max-w-[1600px] items-center gap-1 overflow-x-auto px-5 py-1.5 md:px-8">
            {PRIMARY.map((key) => <TopLink key={key} item={NAV_ITEMS[key] } active={nav === key} />)}
            <ToolsMenu all={all} nav={nav} />
            <span className="ml-auto hidden shrink-0 items-center gap-3 pl-3 text-xs font-semibold text-[#425466] xl:flex">
              <Link href={SITE.url} className="hover:text-[#635bff]">Public site ↗</Link>
              {user.role === "admin" && <Link href="/system" className="hover:text-[#635bff]">System console ↗</Link>}
            </span>
          </div>
        </nav>
        {/* Mobile nav — compact disclosure, unchanged behavior */}
        <nav id="admin-mobile-nav" aria-label="Console" className="border-t border-[#eef1f5] px-5 py-2 lg:hidden">
          <details className="group">
            <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between text-sm font-bold text-[#0a2540] [&::-webkit-details-marker]:hidden">
              Browse programs <span aria-hidden className="text-xl transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="max-h-[65vh] space-y-3 overflow-y-auto pb-4">
              <div className="grid grid-cols-2 gap-1">{PRIMARY.map((key) => <NavLink key={key} item={NAV_ITEMS[key]} active={nav === key} mobile />)}<NavLink item={NAV_ITEMS.search} active={nav === "search"} mobile /></div>
              {GROUPS.map((g) => {
                const items = all.filter(([key, item]) => item.group === g && !(PRIMARY as readonly string[]).includes(key));
                return items.length === 0 ? null : <details key={g} open={items.some(([key]) => key === nav)} className="rounded-lg bg-white p-2">
                  <summary className="cursor-pointer px-2 py-1 text-xs font-semibold uppercase tracking-wider text-[#8898aa]">{g}</summary>
                  <div className="grid grid-cols-2 gap-1 pt-1">{items.map(([key, item]) => <NavLink key={key} item={item} active={nav === key} mobile />)}</div>
                </details>;
              })}
            </div>
          </details>
        </nav>
        <form action="/admin/search" className="flex border-t border-[#eef1f5] px-5 py-2 sm:hidden">
          <input name="q" aria-label="Search internal records and tools" placeholder="Search records and tools" className="min-h-10 min-w-0 flex-1 rounded-l-lg border border-[#e3e8ee] bg-white px-3 text-sm placeholder:text-[#8898aa]" />
          <button className="rounded-r-lg bg-[#635bff] px-3 text-xs font-semibold text-white">Search</button>
        </form>
      </header>

      {related.length > 0 && <nav aria-label={`More in ${NAV_ITEMS[nav].group}`} className="border-b border-[#e3e8ee] bg-white">
        <div className="mx-auto flex max-w-[1600px] items-center gap-2 overflow-x-auto px-5 py-1.5 md:px-8">
          <span className="shrink-0 pr-2 text-[10px] font-semibold uppercase tracking-wider text-[#8898aa]">{NAV_ITEMS[nav].group}</span>
          {related.map(([key, item]) => <Link key={key} href={item.href} className="shrink-0 rounded-full border border-[#e3e8ee] bg-white px-3 py-1.5 text-xs font-semibold text-[#425466] hover:border-[#635bff] hover:text-[#0a2540]">{item.label}</Link>)}
        </div>
      </nav>}
      <main className="mx-auto max-w-[1600px] px-5 py-5 pb-24 md:px-8 lg:pb-8">{children}</main>
      <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-[#e3e8ee] bg-white/95 px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 shadow-[0_-8px_30px_-22px_rgba(10,37,64,.4)] backdrop-blur lg:hidden">
        {MOBILE_PRIMARY.map((key) => <Link key={key} href={NAV_ITEMS[key].href} aria-current={nav === key ? "page" : undefined} className={"flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-bold " + (nav === key ? "text-[#635bff]" : "text-[#425466]")}>{NAV_ITEMS[key].icon}<span>{key === "dashboard" ? "Home" : NAV_ITEMS[key].label}</span></Link>)}
        <Link href="/admin/search" aria-current={nav === "search" ? "page" : undefined} className={"flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-bold " + (nav === "search" ? "text-[#635bff]" : "text-[#425466]")}>{icons.search}<span>Search</span></Link>
      </nav>
    </div>
  );
}
