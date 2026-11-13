import type { ReactNode } from "react";
import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import type { SystemRole } from "@/lib/system/rbac";
import { Logo } from "./Logo";
import { LogoutButton } from "./LogoutButton";
import { SystemNavLink } from "./SystemNavLink";

/**
 * Left-nav shell for system.zapnivo.com — dense technical control-plane chrome.
 * Nav entries that don't exist yet render disabled with a "soon" marker so the
 * information architecture is visible before later stages land.
 */

type NavEntry = { href?: string; label: string; soon?: boolean };
type NavGroup = { name: string; items: NavEntry[] };

const NAV: NavGroup[] = [
  {
    name: "Command Center",
    items: [
      { href: "/system", label: "Overview" },
      { href: "/system/launch", label: "Launch readiness" },
      { href: "/system/search", label: "Global search" },
      { href: "/system/activity", label: "Activity feed" },
      { href: "/system/approvals", label: "Pending approvals" },
      { href: "/system/incidents", label: "Incidents" },
      { href: "/system/status", label: "Status page" },
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
      { href: "/system/kiosks", label: "Fleet registry" },
      { href: "/system/kiosks/register", label: "Register kiosk" },
      { href: "/system/kiosks/maintenance", label: "Maintenance" },
      { href: "/system/kiosks/provision-qr", label: "Provisioning QR" },
      { href: "/system/kiosks/firmware", label: "Firmware" },
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

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const I = ({ children, className = "h-[18px] w-[18px] shrink-0" }: { children: ReactNode; className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className} {...stroke}>{children}</svg>
);
const icons: Record<string, ReactNode> = {
  dashboard: <I><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></I>,
  kiosk: <I><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h6v6H9z" /><path d="M12 1v3M12 20v3M1 12h3M20 12h3" /></I>,
  plug: <I><path d="M9 2v6m6-6v6" /><path d="M6 8h12v4a6 6 0 0 1-12 0V8Z" /><path d="M12 18v4" /></I>,
  db: <I><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></I>,
  layers: <I><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></I>,
  brain: <I><path d="M9.5 2a3.5 3.5 0 0 0-3.4 4.3A3.5 3.5 0 0 0 3 9.8a3.5 3.5 0 0 0 3 5.4A3.5 3.5 0 0 0 9.5 22c.9 0 1.7-.3 2.3-.8V2.8A3.6 3.6 0 0 0 9.5 2Z" /><path d="M14.5 2a3.5 3.5 0 0 1 3.4 4.3 3.5 3.5 0 0 1 3.1 3.5 3.5 3.5 0 0 1-3 5.4 3.5 3.5 0 0 1-3.5 2.8c-.9 0-1.7-.3-2.3-.8V2.8A3.6 3.6 0 0 1 14.5 2Z" /></I>,
  activity: <I><path d="M22 12h-4l-3 8L9 4l-3 8H2" /></I>,
  shield: <I><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" /><path d="M12 8v4" /><path d="M12 15h.01" /></I>,
  code: <I><path d="m8 6-6 6 6 6M16 6l6 6-6 6" /></I>,
  gear: <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></I>,
};
const GROUP_ICONS: Record<string, ReactNode> = {
  "Command Center": icons.dashboard, "Kiosk Infrastructure": icons.kiosk, "APIs & Integrations": icons.plug,
  Database: icons.db, Application: icons.layers, "AI Infrastructure": icons.brain, Observability: icons.activity,
  Security: icons.shield, "Developer Tools": icons.code, "System Settings": icons.gear,
};

function NavItem({ item }: { item: NavEntry }) {
  if (item.soon || !item.href) {
    return (
      <span className="flex cursor-not-allowed items-center justify-between gap-2 rounded-lg px-3.5 py-1.5 text-xs font-bold text-slate-500" title="Planned — not built yet">
        {item.label}<span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-slate-400">soon</span>
      </span>
    );
  }
  return <SystemNavLink href={item.href} label={item.label} />;
}

export function SystemShell({
  user, role, environment, children,
}: {
  user: SessionUser;
  role: SystemRole | null;
  environment?: string;
  children: ReactNode;
}) {
  const env = environment ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
  const isProd = env === "production";
  return (
    <div data-theme="dark" className="min-h-screen bg-[#08091a] text-slate-100 [background-image:radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(217,255,115,0.06),transparent),radial-gradient(ellipse_60%_40%_at_100%_0%,rgba(80,80,200,0.10),transparent)]">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 flex-col border-r border-white/[0.07] bg-[#0b0c22]/90 backdrop-blur lg:flex">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <Link href="/system" aria-label="Zapnivo system"><Logo className="text-[1.15rem]! text-white" /></Link>
          <span className="rounded-full bg-lime px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-widest text-ink">System</span>
        </div>
        <nav aria-label="System console" className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
          {NAV.map((g) => (
            <div key={g.name}>
              <p className="eyebrow mb-1.5 flex items-center gap-2 px-3.5 text-[10px] text-silver">
                <span className="text-lime">{GROUP_ICONS[g.name]}</span>{g.name}
              </p>
              <div className="space-y-0.5">{g.items.map((i) => <NavItem key={i.label} item={i} />)}</div>
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3">
          <div className="rounded-xl bg-white/5 p-3 ring-1 ring-white/10">
            <p className="truncate font-mono text-xs font-bold text-lime">{user.email}</p>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <p className="font-mono text-[10px] font-extrabold uppercase tracking-wider text-silver">
                {role ?? "no system role"}{user.role !== "customer" ? ` · ${user.role}` : ""}
              </p>
              <LogoutButton light />
            </div>
          </div>
        </div>
      </aside>

      <div className="lg:pl-72">
        {/* Topbar */}
        <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#08091a]/80 backdrop-blur-md">
          <div className="flex h-14 items-center justify-between gap-4 px-5">
            <div className="flex items-center gap-3">
              <span className="lg:hidden"><Logo className="text-[1rem]! text-white" /></span>
              <span className="hidden items-center gap-2 font-mono text-[11px] text-slate-500 md:flex">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-lime shadow-[0_0_8px_rgba(217,255,115,0.8)]" aria-hidden />
                system.zapnivo.com
              </span>
              <span className={`rounded-full px-3 py-1 font-mono text-[10px] font-extrabold uppercase tracking-widest ring-1 ${isProd ? "bg-red-500/10 text-red-300 ring-red-400/30" : "bg-lime/10 text-lime ring-lime/30"}`}>
                env: {env}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden font-mono text-[11px] text-silver sm:block">{user.email}</span>
              <span className="rounded-full bg-white/10 px-3 py-1 font-mono text-[10px] font-extrabold uppercase tracking-widest text-lime ring-1 ring-lime/30">
                {role ?? "denied"}
              </span>
              <div className="lg:hidden"><LogoutButton light /></div>
            </div>
          </div>
          {/* Mobile nav: horizontal scroll of live pages only */}
          <nav aria-label="System console" className="flex gap-1 overflow-x-auto px-4 pb-2 lg:hidden">
            {NAV.flatMap((g) => g.items.filter((i) => i.href).map((i) => (
              <SystemNavLink key={i.label} href={i.href!} label={i.label} mobile />
            )))}
          </nav>
        </header>

        <main className="mx-auto max-w-[1440px] px-5 py-8">{children}</main>
      </div>
    </div>
  );
}
