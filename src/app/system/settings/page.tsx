export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";

export const metadata: Metadata = { title: "Settings" };

const SECTIONS = [
  {
    href: "/system/settings/flags",
    title: "Feature flags",
    perm: "system.flags.view",
    desc: "Control-plane flag metadata and audit trail. Toggling records intent + audit event; high-risk flips route through change requests.",
  },
  {
    href: "/system/settings/app",
    title: "App settings",
    perm: "system.flags.view",
    desc: "Whitelisted nonsecret application settings. Writes are audited; high-risk keys require step-up elevation + an approved change request.",
  },
  {
    href: "/system/settings/retention",
    title: "Data retention",
    perm: "system.security.audit.view",
    desc: "Retention policy windows and dry-run/execute controls for scheduled data pruning.",
  },
];

/**
 * Settings index — links the real settings surfaces that exist today. Only
 * lists pages that are implemented; no placeholder settings are fabricated.
 */
export default function SettingsIndexPage() {
  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Settings</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">System settings</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Index of the settings surfaces that exist today. Each section enforces its own
            permission — you may see this page but be restricted inside a section.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {SECTIONS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="group rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] transition hover:border-lime/30 hover:bg-white/[0.07]"
            >
              <h2 className="font-mono text-sm font-bold text-slate-100 group-hover:text-lime">{s.title}</h2>
              <p className="mt-1 font-mono text-[10px] text-slate-500">requires {s.perm}</p>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">{s.desc}</p>
              <p className="mt-3 font-mono text-[11px] text-lime">{s.href} →</p>
            </Link>
          ))}
        </div>

        <p className="text-xs text-slate-500">
          Related: <Link href="/system/security/policy" className="underline hover:text-white">security policy</Link> ·{" "}
          <Link href="/system/dev/env" className="underline hover:text-white">environment diagnostics</Link> ·{" "}
          <Link href="/system/approvals" className="underline hover:text-white">pending approvals</Link>
        </p>
      </div>
    </SystemGate>
  );
}
