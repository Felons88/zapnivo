export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSystemHealth, type HealthState } from "@/lib/system/health-dashboard";

export const metadata: Metadata = { title: "Technical health" };

const TONE: Record<HealthState, string> = {
  healthy: "bg-lime/15 text-lime ring-lime/30",
  degraded: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  unreachable: "bg-red-500/15 text-red-300 ring-red-400/30",
  unconfigured: "bg-white/10 text-slate-300 ring-white/15",
  unverified: "bg-white/[0.04] text-slate-500 ring-white/10",
  awaiting_hardware: "bg-sky-400/10 text-sky-300 ring-sky-400/25",
};

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z"
    : "—";

export default async function HealthPage() {
  const health = await getSystemHealth(serviceClient());

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Health</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Technical health</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              One rollup of recorded evidence across hosts, integrations, jobs, webhooks, the kiosk
              fleet, release campaigns, AI services and alert delivery. No live probes run on page
              load — <span className="font-mono">unverified</span> means no evidence exists,{" "}
              <span className="font-mono">awaiting_hardware</span> means the kiosk control path is
              honestly blocked on a certified vendor adapter. Generated {when(health.generatedAt)}.
            </p>
          </div>
          <span className={`rounded-full px-3 py-1 font-mono text-xs font-bold ring-1 ${TONE[health.overall]}`}>
            overall: {health.overall.replace("_", " ")}
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {health.sections.map((s) => (
            <section
              key={s.id}
              className="flex flex-col rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="eyebrow text-slate-400">{s.title}</h2>
                <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${TONE[s.state]}`}>
                  {s.state.replace("_", " ")}
                </span>
              </div>
              <p className="mt-3 font-mono text-sm font-bold text-slate-100">{s.summary}</p>
              {s.issue && <p className="mt-1.5 text-xs leading-relaxed text-amber-200/90">{s.issue}</p>}
              <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                <span className="font-mono text-[10px] text-slate-500">evidence: {when(s.checkedAt)}</span>
                <Link href={s.href} className="font-mono text-[11px] text-lime underline">
                  {s.hrefLabel} →
                </Link>
              </div>
            </section>
          ))}
        </div>

        <p className="text-xs text-slate-500">
          API: <code className="font-mono">GET /api/system/health</code> (system.dashboard.view) ·
          per-section detail lives on the linked pages — live provider checks:{" "}
          <code className="font-mono">GET /api/system/integrations/{"{id}"}/health</code>
        </p>
      </div>
    </SystemGate>
  );
}
