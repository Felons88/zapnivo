import type { ReactNode } from "react";
import Link from "next/link";
import { isStaff, type SessionUser } from "@/lib/auth";
import { subUrl } from "@/lib/site";
import { roleCan, type SystemPermission, type SystemRole } from "@/lib/system/rbac";
import routePermissions from "@/lib/system/route-permissions.json";
import { Logo } from "./Logo";
import { LogoutButton } from "./LogoutButton";
import { SystemDesktopNavigation, SystemMobileNavigation, SystemPageContext } from "./SystemNavigation";
import { SystemThemeToggle, type SystemTheme } from "./SystemThemeToggle";
import { SystemSidebarToggle } from "./SystemSidebarToggle";

/**
 * Left-nav shell for system.zapnivo.com — dense technical control-plane chrome.
 * Nav entries that don't exist yet render disabled with a "soon" marker so the
 * information architecture is visible before later stages land.
 */

export type NavEntry = { href?: string; label: string; soon?: boolean };
export type NavGroup = { name: string; items: NavEntry[] };

export const NAV: NavGroup[] = [
  {
    name: "Command Center",
    items: [
      { href: "/system", label: "Applications" },
      { href: "/system/overview", label: "System overview" },
      { href: "/system/launch", label: "Launch readiness" },
      { href: "/system/search", label: "Global search" },
      { href: "/system/activity", label: "Activity feed" },
      { href: "/system/approvals", label: "Pending approvals" },
      { href: "/system/incidents", label: "Incidents" },
      { href: "/system/status", label: "Status page" },
      { href: "/system/health", label: "System health" },
      { href: "/system/emergency", label: "Emergency controls" },
    ],
  },
  {
    name: "Websites",
    items: [
      { href: "/system/sites", label: "All websites" },
    ],
  },
  {
    name: "Deployments",
    items: [
      { href: "/system/deployments", label: "Deployment center" },
      { href: "/system/deployments/github", label: "GitHub" },
      { href: "/system/app/deployments", label: "Deployment requests" },
    ],
  },
  {
    name: "Kiosk Infrastructure",
    items: [
      { href: "/system/venues", label: "Venues" },
      { href: "/system/kiosks", label: "Fleet registry" },
      { href: "/system/kiosks/register", label: "Register kiosk" },
      { href: "/system/kiosks/maintenance", label: "Maintenance" },
      { href: "/system/kiosks/provision-qr", label: "Provisioning QR" },
      { href: "/system/kiosks/firmware", label: "Firmware" },
      { href: "/system/kiosks/updates", label: "Updates" },
      { href: "/system/kiosks/hardware", label: "Hardware readiness" },
      { href: "/system/kiosks/certification", label: "Certification" },
      { href: "/system/kiosks/onboarding", label: "Onboarding" },
      { href: "/system/kiosks/commands", label: "Commands" },
      { href: "/system/kiosks/exceptions", label: "Exceptions" },
    ],
  },
  {
    name: "Infrastructure",
    items: [
      { href: "/system/infrastructure", label: "Overview" },
      { href: "/system/infrastructure/database", label: "Database admin" },
      { href: "/system/infrastructure/webhooks", label: "Webhook inspector" },
      { href: "/system/infrastructure/api", label: "API services" },
      { href: "/system/infrastructure/jobs", label: "Cron detail" },
      { href: "/system/jobs", label: "Jobs & workers" },
    ],
  },
  {
    name: "APIs & Integrations",
    items: [
      { href: "/system/integrations", label: "Integrations" },
      { href: "/system/webhooks", label: "Webhooks" },
      { href: "/system/secrets", label: "Secrets" },
      { href: "/system/keys", label: "API keys" },
    ],
  },
  {
    name: "Database",
    items: [
      { href: "/system/database", label: "Overview" },
      { href: "/system/database/schema", label: "Schema" },
      { href: "/system/database/migrations", label: "Migrations" },
      { label: "Query console", soon: true },
    ],
  },
  {
    name: "Application",
    items: [
      { href: "/system/settings/flags", label: "Feature flags" },
      { href: "/system/app/environments", label: "Environments" },
    ],
  },
  {
    name: "AI Infrastructure",
    items: [
      { href: "/system/ai", label: "Agents & models" },
      { href: "/system/ai/models", label: "Models" },
      { href: "/system/ai/evals", label: "Evals" },
      { href: "/system/ai/guardrails", label: "Guardrails" },
    ],
  },
  {
    name: "Observability",
    items: [
      { href: "/system/observability", label: "Overview" },
      { href: "/system/observability/errors", label: "Errors" },
      { href: "/system/observability/logs", label: "Logs" },
      { href: "/system/observability/traces", label: "Traces" },
      { href: "/system/observability/crons", label: "Cron jobs" },
      { href: "/system/observability/alerts", label: "Alerts" },
    ],
  },
  {
    name: "Security",
    items: [
      { href: "/system/security/audit", label: "Audit log" },
      { href: "/system/activity", label: "Activity feed" },
      { href: "/system/changes", label: "Change requests" },
      { href: "/system/security/users", label: "Technical users" },
      { href: "/system/security/mfa", label: "MFA & step-up" },
      { href: "/system/security/sessions", label: "Sessions" },
      { href: "/system/security/policy", label: "Security policy" },
      { href: "/system/security/bootstrap", label: "Admin bootstrap" },
    ],
  },
  {
    name: "Developer Tools",
    items: [
      { href: "/system/dev", label: "Overview" },
      { href: "/system/dev/env", label: "Env diagnostics" },
      { href: "/system/dev/docs", label: "Docs & runbooks" },
      { href: "/system/dev/api", label: "API catalog" },
      { href: "/system/dev/api-explorer", label: "API explorer" },
      { href: "/system/dev/webhooks-tester", label: "Webhook tester" },
      { href: "/system/dev/simulator", label: "Kiosk simulator" },
      { href: "/system/dev/simulator/console", label: "Simulator console" },
    ],
  },
  {
    name: "System Settings",
    items: [
      { href: "/system/settings", label: "Overview" },
      { href: "/system/security/users", label: "Roles & access" },
      { href: "/system/app/environments", label: "Integrations config" },
      { href: "/system/settings/retention", label: "Retention" },
      { href: "/system/recovery", label: "Disaster recovery" },
    ],
  },
];

export function SystemShell({
  user, role, environment, theme = "dark", children,
}: {
  user: SessionUser;
  role: SystemRole | null;
  environment?: string;
  theme?: SystemTheme;
  children: ReactNode;
}) {
  const env = environment ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
  const isProd = env === "production";
  const businessStaff = isStaff(user);
  const groups = NAV.map((group) => ({ ...group, items: group.items.filter((item) => {
    if (!item.href) return false;
    if (item.href === "/system") return !!role || businessStaff;
    if (item.href === "/system/security/bootstrap") return !role;
    const perm = (routePermissions as Record<string, string>)[item.href];
    return !!perm && roleCan(role, perm as SystemPermission);
  }) })).filter((group) => group.items.length);
  if (businessStaff) groups.splice(1, 0, { name: "Business applications", items: [
    { href: subUrl("internal", "/support"), label: "Customer service" },
    { href: subUrl("internal", "/customers"), label: "Customer accounts" },
    { href: subUrl("internal", "/partners"), label: "Venue management" },
    ...(user.role === "admin" ? [{ href: subUrl("internal", "/finance"), label: "Finance" }] : []),
    { href: subUrl("internal", "/analytics"), label: "Analytics" },
    { href: subUrl("internal", "/users"), label: "Staff administration" },
  ] });
  const compactPaths = ["/system", "/system/kiosks", "/system/observability", "/system/deployments", "/system/sites", "/system/security/audit"];
  const compactItems = compactPaths.map((href) => groups.flatMap((group) => group.items).find((item) => item.href === href)).filter((item): item is NavEntry & { href: string } => !!item?.href);
  return (
    <div data-theme={theme} className="system-console min-h-screen bg-[#0b1219] text-slate-100">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[272px] flex-col border-r border-white/[0.08] bg-[#101923] lg:flex">
        <div className="system-sidebar-brand flex h-[72px] items-center gap-3 border-b border-white/[0.08] px-5">
          <Link href="/system" aria-label="Zapnivo applications" className="system-brand-logo min-w-0"><Logo className="text-[1.05rem]! text-white" /></Link>
          <span className="system-brand-badge ml-auto rounded-md border border-lime/35 bg-lime/10 px-2 py-1 text-[9px] font-extrabold uppercase tracking-[0.15em] text-lime">System</span>
          <SystemSidebarToggle />
        </div>
        <div className="system-full-nav flex min-h-0 flex-1 flex-col"><SystemDesktopNavigation groups={groups} /></div>
        <nav aria-label="Compact system navigation" className="system-compact-nav hidden min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto py-4">
          {compactItems.map((item) => <Link key={item.href} href={item.href} title={item.label} aria-label={item.label} className="grid size-11 shrink-0 place-items-center rounded-xl border border-[var(--sys-border)] bg-[var(--sys-surface)] text-sm font-bold text-[var(--sys-text)] hover:border-[var(--sys-accent)]">{item.label.slice(0, 1).toUpperCase()}</Link>)}
        </nav>
        <div className="system-sidebar-profile border-t border-white/[0.08] p-4">
          <div className="flex items-center gap-3 rounded-xl bg-white/[0.05] p-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-lime/15 text-xs font-extrabold text-lime">{user.email.slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0"><p className="truncate text-xs font-semibold text-slate-100">{user.email}</p><p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-400">{role ?? "Restricted access"}</p></div>
          </div>
        </div>
      </aside>

      <div className="min-w-0 lg:pl-[272px]">
        <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-[#0b1219]/95">
          <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6 xl:px-9">
            <div className="flex min-w-0 items-center gap-3">
              <SystemMobileNavigation groups={groups} />
              <span className="lg:hidden"><Logo className="text-[1rem]! text-white" /></span>
              <div className="hidden lg:block"><SystemPageContext groups={groups} /></div>
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <Link href="/system" className="hidden h-9 items-center rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 text-xs font-bold text-[var(--sys-text)] hover:border-[var(--sys-accent)] sm:flex">Applications</Link>
              <Link href={roleCan(role, "system.dashboard.view") ? "/system/search" : subUrl("internal", "/search")} className="hidden h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs font-semibold text-slate-300 hover:border-lime/40 hover:text-white sm:flex" aria-label="Global search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className="size-4"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 5 5"/></svg>Search
              </Link>
              {roleCan(role, "system.security.audit.view") && <Link href="/system/observability/alerts" aria-label="System alerts" title="System alerts" className="hidden h-9 items-center rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 text-xs font-bold text-[var(--sys-text)] hover:border-[var(--sys-accent)] md:flex">Alerts</Link>}
              {(roleCan(role, "system.dashboard.view") || businessStaff) && <Link href={roleCan(role, "system.dashboard.view") ? "/system/dev/docs" : subUrl("internal", "/knowledge")} className="hidden text-xs font-semibold text-[var(--sys-muted)] hover:text-[var(--sys-text)] xl:block">Help</Link>}
              <SystemThemeToggle initialTheme={theme} />
              <span className={`inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[10px] font-bold uppercase tracking-wider ${isProd ? "border-amber-300/30 bg-amber-300/10 text-amber-200" : "border-lime/25 bg-lime/10 text-lime"}`}>
                <span className={`size-1.5 rounded-full ${isProd ? "bg-amber-300" : "bg-lime"}`} />{env}
              </span>
              <span className="hidden max-w-40 truncate text-xs text-slate-400 xl:block" title={`${user.email} · ${role ?? user.role}`}>{user.email}</span>
              <LogoutButton />
            </div>
          </div>
          <div className="border-t border-white/[0.05] px-4 py-2 sm:px-6 lg:hidden"><SystemPageContext groups={groups} /></div>
        </header>
        <main id="system-main" className="mx-auto w-full max-w-[1640px] px-4 pb-20 pt-7 sm:px-6 sm:pt-8 xl:px-9">{children}</main>
      </div>
    </div>
  );
}
