export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSystemStatus, type StatusLevel } from "@/lib/system/status";

export const metadata: Metadata = { title: "Status" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const tone: Record<StatusLevel, string> = {
  operational: "bg-lime/15 text-lime ring-lime/30",
  degraded: "bg-red-500/15 text-red-300 ring-red-400/30",
  unconfigured: "bg-white/10 text-slate-300 ring-white/15",
  unknown: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
};

const GROUPS: { match: (c: string) => boolean; label: string }[] = [
  { match: (c) => c === "supabase", label: "Platform" },
  { match: (c) => ["stripe", "brevo", "twilio", "openrouter"].includes(c), label: "Integrations" },
  { match: (c) => c === "kiosk_adapter", label: "Hardware" },
  { match: (c) => c.startsWith("cron:"), label: "Cron jobs" },
  { match: (c) => c === "error_events", label: "Observability" },
  { match: (c) => c.startsWith("uptime:"), label: "Uptime probes" },
];

export default async function StatusPage() {
  const db = serviceClient();
  const s = await getSystemStatus(db);

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Status</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Technical status</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Real signals only — Supabase probe, provider configured-flags, kiosk adapter, cron run ages,
            24h error count, and latest uptime checks. <span className="font-mono">unknown</span> means we
            genuinely can&apos;t verify; <span className="font-mono">unconfigured</span> means missing env —
            neither is claimed as healthy. Checked {when(s.checkedAt)}.
          </p>
        </div>

        {/* Summary pills */}
        <div className="flex flex-wrap gap-2">
          {(Object.keys(s.summary) as StatusLevel[]).map((k) => (
            <span key={k} className={`rounded-full px-3 py-1 font-mono text-xs font-bold ring-1 ${tone[k]}`}>
              {s.summary[k]} {k}
            </span>
          ))}
        </div>

        {!s.configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — only env-level signals are shown.
          </p>
        )}

        {GROUPS.map((g) => {
          const rows = s.rows.filter((r) => g.match(r.component));
          if (rows.length === 0) return null;
          return (
            <section key={g.label} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
              <h2 className="eyebrow text-slate-400">{g.label}</h2>
              <ul className="mt-3 divide-y divide-white/5">
                {rows.map((r) => (
                  <li key={r.component} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-bold text-slate-200">{r.component}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{r.detail}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="font-mono text-[10px] text-slate-500">{when(r.checkedAt)}</span>
                      <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${tone[r.status]}`}>{r.status}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        <p className="text-xs text-slate-500">
          Unified rollup: <a href="/system/health" className="text-lime underline">/system/health</a> · API:{" "}
          <code className="font-mono">GET /api/system/status</code> · live provider checks:{" "}
          <code className="font-mono">GET /api/system/integrations/{"{id}"}/health</code>
        </p>
      </div>
    </SystemGate>
  );
}
