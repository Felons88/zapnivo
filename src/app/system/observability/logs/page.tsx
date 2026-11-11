export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { listAppLogs, type LogLevel } from "@/lib/system/observability";

export const metadata: Metadata = { title: "Observability — Logs" };

const LEVELS: LogLevel[] = ["debug", "info", "warning", "error", "critical"];
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC" }) + "Z";

const levelTone = (l: string) =>
  l === "error" || l === "critical" ? "text-red-300" : l === "warning" ? "text-amber-300" : "text-slate-400";

export default async function SystemLogsPage({ searchParams }: { searchParams: Promise<{ level?: string; service?: string }> }) {
  const { level, service } = await searchParams;
  const db = serviceClient();
  const validLevel = LEVELS.includes(level as LogLevel) ? (level as LogLevel) : undefined;
  const logs = db ? await listAppLogs(db, { level: validLevel, service: service?.slice(0, 60) || undefined, limit: 200 }) : [];

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { level: validLevel, service, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/system/observability/logs${s ? `?${s}` : ""}`;
  };

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Observability</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Application logs</h1>
          <p className="mt-1 text-sm text-slate-400">
            Latest 200 rows from <code className="font-mono text-xs">app_logs</code>. Messages are scrubbed of
            secrets/PII at write time and re-scrubbed on read.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href={qs({ level: undefined })} className={`rounded-full px-3 py-1.5 text-xs font-bold ${!validLevel ? "bg-lime text-ink" : "bg-white/10 text-slate-200 ring-1 ring-white/15 hover:bg-white/15"}`}>All levels</Link>
          {LEVELS.map((l) => (
            <Link key={l} href={qs({ level: l })} className={`rounded-full px-3 py-1.5 font-mono text-[11px] font-bold ${validLevel === l ? "bg-lime text-ink" : "bg-white/10 text-slate-200 ring-1 ring-white/15 hover:bg-white/15"}`}>{l}</Link>
          ))}
          {service && (
            <span className="ml-2 rounded-full bg-sky-400/15 px-3 py-1.5 font-mono text-[11px] font-bold text-sky-300 ring-1 ring-sky-400/30">
              service: {service} <Link href={qs({ service: undefined })} className="ml-1 underline">✕</Link>
            </span>
          )}
        </div>

        <section className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.04]">
          {!db ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — logs unavailable.</p>
          ) : logs.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No log lines{validLevel || service ? " match the current filters" : " yet"}.</p>
          ) : (
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["When", "Level", "Service", "Message", "Route", "Trace"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody className="font-mono">
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">{when(l.ts)}</td>
                    <td className={`whitespace-nowrap px-4 py-2.5 font-bold uppercase ${levelTone(l.level)}`}>{l.level}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-300">{l.service}</td>
                    <td className="max-w-md px-4 py-2.5"><span className="line-clamp-2 break-all text-slate-300">{l.message}</span></td>
                    <td className="max-w-[10rem] truncate px-4 py-2.5 text-[10px] text-slate-500">{l.route ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[10px] text-slate-500">{l.trace_id ? l.trace_id.slice(0, 10) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </SystemGate>
  );
}
