export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { listErrorEvents, listErrorIssues } from "@/lib/system/observability";

export const metadata: Metadata = { title: "Observability — Errors" };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z";
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const STATUS_TONE: Record<string, string> = {
  new: "bg-red-500/15 text-red-300 ring-red-400/30",
  investigating: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  assigned: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  resolved: "bg-white/10 text-slate-300 ring-white/15",
  ignored: "bg-white/10 text-slate-400 ring-white/15",
  regressed: "bg-red-500/15 text-red-300 ring-red-400/30",
};
const SEV_TONE: Record<string, string> = {
  critical: "bg-red-500/15 text-red-300 ring-red-400/30",
  error: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  warning: "bg-white/10 text-slate-300 ring-white/15",
};

export default async function SystemErrorsPage() {
  const db = serviceClient();
  const [issues, events] = db
    ? await Promise.all([listErrorIssues(db, 100), listErrorEvents(db, 60)])
    : [[], []] as const;

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-lime">Observability</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Error issues</h1>
          <p className="mt-1 text-sm text-slate-400">
            Grouped by fingerprint (exception type + top frame + route). Status changes happen in the business admin
            observability console — this system view is read-only. Payloads are scrubbed at write and re-scrubbed on read.
          </p>
        </div>

        <section className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.04]">
          {!db ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — error issues unavailable.</p>
          ) : issues.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No error issues captured yet.</p>
          ) : (
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Issue", "Status", "Severity", "Events", "Culprit", "First seen", "Last seen"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {issues.map((i) => (
                  <tr key={i.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="max-w-md px-4 py-3">
                      <div className="font-bold text-slate-200">{i.title}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-slate-500">{i.fingerprint}</div>
                    </td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATUS_TONE[i.status] ?? "bg-white/10 text-slate-300 ring-white/15"}`}>{i.status}</span></td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${SEV_TONE[i.severity] ?? "bg-white/10 text-slate-300 ring-white/15"}`}>{i.severity}</span></td>
                    <td className="px-4 py-3 font-mono font-bold">{i.event_count}</td>
                    <td className="max-w-[10rem] truncate px-4 py-3 font-mono text-[10px] text-slate-400">{i.culprit ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{ago(i.first_seen)}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{ago(i.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <h2 className="eyebrow text-slate-400">Recent error events</h2>
          {!db || events.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">No recent error events.</p>
          ) : (
            <ul className="mt-3 max-h-[28rem] space-y-1.5 overflow-y-auto">
              {events.map((e) => (
                <li key={e.id} className="rounded-lg bg-black/20 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs font-bold text-slate-200">{e.title}</span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-500">{when(e.occurred_at)}</span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                    {e.route ?? "—"} · {e.runtime} · <span className={e.severity === "critical" ? "text-red-300" : "text-amber-300"}>{e.severity}</span>
                    {e.message ? ` · ${e.message}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SystemGate>
  );
}
