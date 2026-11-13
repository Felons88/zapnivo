export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";

export const metadata: Metadata = { title: "Infrastructure" };

const SECTIONS = [
  {
    href: "/system/infrastructure/database",
    title: "Database",
    perm: "system.database.schema.view",
    blurb: "Connectivity probe, bounded row counts on key tables, migration/RLS repo scans, backup & retention state. Postgres internals PostgREST can't reach are shown honestly as unavailable.",
  },
  {
    href: "/system/infrastructure/webhooks",
    title: "Webhook inspector",
    perm: "system.integrations.view",
    blurb: "Every inbound event surface — Stripe, inbound email (incl. quarantine), Twilio SMS, device auth telemetry, email outbox — with 24h counts, sanitized detail, and replay eligibility.",
  },
  {
    href: "/system/infrastructure/api",
    title: "API services",
    perm: "system.integrations.view",
    blurb: "Route inventory for all of /api — scanned from src/app/api at request time, auth classified by detected guard tokens. Inventory, not uptime monitoring.",
  },
  {
    href: "/system/infrastructure/jobs",
    title: "Jobs deep-dive",
    perm: "system.dashboard.view",
    blurb: "Per-cron-job last run detail, failure context, and observed trace-span duration on top of the Jobs & workers overview.",
  },
] as const;

export default function InfrastructurePage() {
  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-lime">Infrastructure</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Infrastructure management</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Consolidated read models over the database, webhook/event surfaces, API route inventory,
            and job runners. Everything is read-only and honestly labeled — nothing here executes
            arbitrary SQL, replays payment events, or fabricates metrics PostgREST cannot reach.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {SECTIONS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="group rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] transition hover:border-lime/30 hover:bg-white/[0.07]"
            >
              <h2 className="font-display text-lg font-bold text-slate-100 group-hover:text-lime">{s.title}</h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">{s.blurb}</p>
              <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-slate-500">perm: {s.perm}</p>
            </Link>
          ))}
        </div>

        <p className="text-xs text-slate-500">
          Related surfaces: <Link className="text-lime underline" href="/system/database">/system/database</Link> ·{" "}
          <Link className="text-lime underline" href="/system/webhooks">/system/webhooks</Link> ·{" "}
          <Link className="text-lime underline" href="/system/jobs">/system/jobs</Link> ·{" "}
          <Link className="text-lime underline" href="/system/security/readiness">/system/security/readiness</Link>
        </p>
      </div>
    </SystemGate>
  );
}
