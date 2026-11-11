import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authConfigured, devAuth, getSessionUser, isStaff } from "@/lib/auth";
import { Logo } from "./Logo";
import { LogoutButton } from "./LogoutButton";
import { Notice } from "./ui";
import { SITE } from "@/lib/site";

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
} satisfies Record<string, ReactNode>;

export type AdminNavKey = keyof typeof NAV_ITEMS;

const NAV_ITEMS = {
  dashboard: { href: "/admin", label: "Dashboard", icon: icons.dashboard, group: "Overview" },
  analytics: { href: "/admin/analytics", label: "Analytics", icon: icons.chart, group: "Growth" },
  inbox: { href: "/admin/support", label: "Inbox", icon: icons.inbox, group: "Support" },
  partner: { href: "/admin/support?queue=partner", label: "Partner relations", icon: icons.building, group: "Support" },
  safety: { href: "/admin/support?queue=safety", label: "Safety", icon: icons.shield, group: "Support" },
  refunds: { href: "/admin/support/refunds", label: "Refunds", icon: icons.coins, group: "Support" },
  metrics: { href: "/admin/support/metrics", label: "Metrics", icon: icons.chart, group: "Support" },
  inquiries: { href: "/admin/inquiries", label: "Inquiries", icon: icons.mail, group: "Support" },
  receptionist: { href: "/admin/receptionist", label: "AI receptionist", icon: icons.chat, group: "Support" },
  sms: { href: "/admin/sms", label: "SMS log", icon: icons.chat, group: "Support" },
  emailStudio: { href: "/admin/email-studio", label: "Email studio", icon: icons.mail, group: "Support" },
  fleet: { href: "/admin/fleet", label: "Fleet", icon: icons.battery, group: "Operations" },
  rentals: { href: "/admin/rentals", label: "Rentals", icon: icons.swap, group: "Operations" },
  partners: { href: "/admin/partners", label: "Partners", icon: icons.store, group: "Operations" },
  onboarding: { href: "/admin/onboarding", label: "Onboarding", icon: icons.steps, group: "Operations" },
  sla: { href: "/admin/sla", label: "Partner SLA", icon: icons.clock, group: "Operations" },
  advertising: { href: "/admin/advertising", label: "Advertising", icon: icons.megaphone, group: "Operations" },
  payouts: { href: "/admin/payouts", label: "Ledgers & payouts", icon: icons.coins, group: "Finance" },
  finance: { href: "/admin/finance", label: "Revenue", icon: icons.chart, group: "Finance" },
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

const GROUPS = ["Overview", "Growth", "Support", "Operations", "Finance", "System", "Intelligence"] as const;

function NavLink({ item, active }: { item: (typeof NAV_ITEMS)[AdminNavKey]; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-lg px-3.5 py-2 text-sm font-bold transition-colors ${
        active ? "bg-lime text-ink" : "text-graphite hover:bg-mist hover:text-ink"
      }`}
    >
      <span className={active ? "text-ink" : "text-silver"}>{item.icon}</span>
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

  const all = Object.entries(NAV_ITEMS) as [AdminNavKey, (typeof NAV_ITEMS)[AdminNavKey]][];
  return (
    <div className="min-h-screen bg-[#f2f1fa] text-ink">
      {devAuth() && (
        <div className="relative z-50 bg-gold px-4 py-2 text-center text-xs font-bold text-ink">
          DEV STORE · not real data · acting as <b>{user.email}</b> ({user.role}) — switch:{" "}
          {(["admin", "admin2", "agent", "partner"] as const).map((r) => <a key={r} href={`/api/dev/as?role=${r}&back=/${r === "partner" ? "partners/support" : "admin/support"}`} className="mx-1 underline">{r}</a>)}
        </div>
      )}

      {/* Sidebar (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 flex-col border-r border-mist bg-white lg:flex">
        <div className="flex items-center justify-between border-b border-mist px-6 py-4">
          <Link href="/admin" aria-label="Zapnivo internal"><Logo className="text-[1.25rem]!" /></Link>
          <span className="rounded-full bg-forest px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-widest text-lime">Internal</span>
        </div>
        <nav aria-label="Console" className="flex-1 space-y-2 px-4 py-4">
          {GROUPS.map((g) => {
            const items = all.filter(([, i]) => i.group === g);
            if (g === "Overview") return <div key={g} className="space-y-0.5">{items.map(([key, item]) => <NavLink key={key} item={item} active={nav === key} />)}</div>;
            return (
              <details key={g} open={items.some(([key]) => key === nav)} className="group">
                <summary className="eyebrow flex cursor-pointer list-none items-center justify-between rounded-lg px-3.5 py-1.5 text-[10px] text-silver hover:text-ink [&::-webkit-details-marker]:hidden">
                  {g}<span aria-hidden className="transition-transform group-open:rotate-90">›</span>
                </summary>
                <div className="mt-0.5 space-y-0.5">{items.map(([key, item]) => <NavLink key={key} item={item} active={nav === key} />)}</div>
              </details>
            );
          })}
        </nav>
        <div className="border-t border-mist p-3">
          <div className="rounded-xl bg-mist/60 p-3">
            <p className="truncate text-sm font-bold">{user.email}</p>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <p className="text-xs font-bold uppercase tracking-wider text-graphite">{user.role}</p>
              <LogoutButton light />
            </div>
          </div>
          <Link href={SITE.url} className="mt-2 flex items-center justify-center gap-1.5 py-1 text-xs font-bold text-graphite hover:text-ink">View public site ↗</Link>
        </div>
      </aside>

      <div className="lg:pl-72">
        {/* Topbar */}
        <header className="sticky top-0 z-30 border-b border-mist bg-[#f2f1fa]/85 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-4 px-5 md:px-8">
            <h1 className="truncate font-display text-xl font-bold tracking-tight">{title}</h1>
            <div className="flex items-center gap-3">
              <span className="hidden items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-bold text-graphite ring-1 ring-mist sm:flex">
                <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden />{user.email}
              </span>
              <Link href={SITE.url} className="hidden rounded-full border border-silver/60 px-4 py-2 text-xs font-bold hover:border-ink md:block">View site</Link>
              <div className="lg:hidden"><LogoutButton light /></div>
            </div>
          </div>
          {/* Mobile nav */}
          <nav aria-label="Console" className="flex gap-1 overflow-x-auto px-4 pb-3 lg:hidden">
            {all.map(([key, item]) => (
              <Link key={key} href={item.href} aria-current={nav === key ? "page" : undefined}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ${nav === key ? "bg-ink text-white" : "bg-white text-graphite"}`}>
                {item.icon}{item.label}
              </Link>
            ))}
          </nav>
        </header>

        <main className="mx-auto max-w-[1440px] px-5 py-8 md:px-8">{children}</main>
      </div>
    </div>
  );
}
