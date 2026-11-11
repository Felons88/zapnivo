export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { Metric } from "@/components/PortalShell";
import { serviceClient } from "@/lib/supabase";
import { IssueActions } from "./IssueActions";
import { AnalyzeButton } from "./AnalyzeButton";

export const metadata: Metadata = { title: "Observability", robots: { index: false, follow: false } };

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const ISSUE_TONE: Record<string, string> = {
  new: "bg-red-100 text-red-800", investigating: "bg-amber-100 text-amber-800", assigned: "bg-blue-100 text-blue-800",
  resolved: "bg-mist text-graphite", ignored: "bg-mist text-graphite", regressed: "bg-red-100 text-red-800",
};

export default async function Observability() {
  const db = serviceClient();
  const since24 = new Date(Date.now() - 86400_000).toISOString();

  const [issuesRes, eventsRes, logsRes, uptimeRes, cronRes, incidentsRes] = db
    ? await Promise.all([
        db.from("error_issues").select("id,fingerprint,title,culprit,status,severity,event_count,first_seen,last_seen").order("last_seen", { ascending: false }).limit(50),
        db.from("error_events").select("id,title,message,route,runtime,severity,occurred_at").gte("occurred_at", since24).order("occurred_at", { ascending: false }).limit(30),
        db.from("app_logs").select("id,ts,level,service,message,route").order("ts", { ascending: false }).limit(40),
        db.from("uptime_checks").select("url,ok,status_code,latency_ms,checked_at").gte("checked_at", since24).order("checked_at", { ascending: false }).limit(200),
        db.from("cron_runs").select("job,ok,detail,ran_at").order("ran_at", { ascending: false }).limit(20),
        db.from("incidents").select("id,number,title,severity,status,source,detected_at,resolved_at").order("detected_at", { ascending: false }).limit(20),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }] as const;

  const issues = (issuesRes.data ?? []) as { id: string; fingerprint: string; title: string; culprit: string | null; status: string; severity: string; event_count: number; first_seen: string; last_seen: string }[];
  const events = (eventsRes.data ?? []) as { id: number; title: string; message: string | null; route: string | null; runtime: string; severity: string; occurred_at: string }[];
  const logs = (logsRes.data ?? []) as { id: number; ts: string; level: string; service: string; message: string; route: string | null }[];
  const uptime = (uptimeRes.data ?? []) as { url: string; ok: boolean; status_code: number | null; latency_ms: number | null; checked_at: string }[];
  const crons = (cronRes.data ?? []) as { job: string; ok: boolean; ran_at: string }[];
  const incidents = (incidentsRes.data ?? []) as { id: string; number: string; title: string; severity: string; status: string; source: string | null; detected_at: string; resolved_at: string | null }[];

  const errors24 = events.length;
  const criticalOpen = issues.filter((i) => (i.status === "new" || i.status === "regressed") && i.severity === "critical").length;
  const activeIncidents = incidents.filter((i) => i.status !== "resolved").length;
  const upRows = [...new Map(uptime.map((u) => [u.url, u])).values()];
  const uptimePct = uptime.length ? Math.round((uptime.filter((u) => u.ok).length / uptime.length) * 100) : null;
  const cronFails = crons.filter((c) => !c.ok).length;

  return (
    <AdminGate title="Observability" nav="observability">
      <div className="space-y-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Errors (24h)" value={errors24} />
          <Metric label="Critical issues" value={criticalOpen} />
          <Metric label="Active incidents" value={activeIncidents} />
          <Metric label="Uptime (24h)" value={uptimePct === null ? "—" : `${uptimePct}%`} />
          <Metric label="Failed cron runs" value={cronFails} />
        </div>

        <section className="rounded-2xl border border-mist bg-white p-6">
          <h2 className="text-lg font-bold">Error issues</h2>
          <p className="mt-1 text-sm text-graphite">Grouped by fingerprint — repeated errors update the same issue; resolved issues that recur are marked <em>regressed</em>.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite"><th className="py-2 pr-4">Issue</th><th className="py-2 pr-4">Status</th><th className="py-2 pr-4">Events</th><th className="py-2 pr-4">Route</th><th className="py-2 pr-4">First seen</th><th className="py-2">Last seen</th><th className="py-2 pl-4">Actions</th></tr></thead>
              <tbody>
                {issues.map((i) => (
                  <tr key={i.id} className="border-b border-mist/60 align-top">
                    <td className="max-w-md py-2 pr-4"><span className="font-semibold">{i.title}</span><div className="mt-0.5 font-mono text-[10px] text-graphite">{i.fingerprint}</div></td>
                    <td className="py-2 pr-4"><span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold uppercase ${ISSUE_TONE[i.status] ?? "bg-mist"}`}>{i.status}</span></td>
                    <td className="py-2 pr-4 font-bold">{i.event_count}</td>
                    <td className="max-w-[10rem] truncate py-2 pr-4 text-graphite">{i.culprit ?? "—"}</td>
                    <td className="py-2 pr-4 text-graphite">{ago(i.first_seen)}</td>
                    <td className="py-2 text-graphite">{ago(i.last_seen)}</td>
                    <td className="py-2 pl-4"><div className="flex flex-col items-start gap-1"><IssueActions fingerprint={i.fingerprint} current={i.status} /><AnalyzeButton issueId={i.id} /></div></td>
                  </tr>
                ))}
                {issues.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-graphite">No errors captured yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-mist bg-white p-6">
            <h2 className="text-lg font-bold">Recent errors (24h)</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {events.map((e) => (
                <li key={e.id} className="rounded-lg bg-paper px-3 py-2">
                  <div className="flex items-center justify-between gap-2"><span className="truncate font-semibold">{e.title}</span><span className="shrink-0 text-xs text-graphite">{ago(e.occurred_at)}</span></div>
                  <p className="mt-0.5 truncate text-xs text-graphite">{e.route ?? "—"} · {e.runtime} · {e.severity}</p>
                </li>
              ))}
              {events.length === 0 && <li className="text-graphite">No errors in the last 24 hours.</li>}
            </ul>
          </section>

          <section className="rounded-2xl border border-mist bg-white p-6">
            <h2 className="text-lg font-bold">Incidents</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {incidents.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 rounded-lg bg-paper px-3 py-2">
                  <div><span className="font-semibold">{i.number}</span> <span className="text-graphite">{i.title}</span></div>
                  <span className="shrink-0 rounded-full bg-mist px-2 py-0.5 text-[11px] font-extrabold uppercase">{i.status}</span>
                </li>
              ))}
              {incidents.length === 0 && <li className="text-graphite">No incidents recorded.</li>}
            </ul>
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-mist bg-white p-6">
            <h2 className="text-lg font-bold">Uptime monitors</h2>
            <p className="mt-1 text-xs text-graphite">Latest check per target. Sustained failures (3 consecutive) auto-create incidents. Hit <code>/api/cron/uptime</code> with CRON_SECRET from an external scheduler for frequent checks.</p>
            <table className="mt-3 w-full text-sm">
              <thead><tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite"><th className="py-2 pr-4">Target</th><th className="py-2 pr-4">Status</th><th className="py-2 pr-4">HTTP</th><th className="py-2 pr-4">Latency</th><th className="py-2">Checked</th></tr></thead>
              <tbody>
                {upRows.map((u) => (
                  <tr key={u.url} className="border-b border-mist/60">
                    <td className="max-w-[12rem] truncate py-2 pr-4 font-mono text-xs">{u.url}</td>
                    <td className="py-2 pr-4"><span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ${u.ok ? "bg-lime/40 text-forest" : "bg-red-100 text-red-800"}`}>{u.ok ? "up" : "down"}</span></td>
                    <td className="py-2 pr-4">{u.status_code ?? "—"}</td>
                    <td className="py-2 pr-4">{u.latency_ms ?? "—"}ms</td>
                    <td className="py-2 text-graphite">{ago(u.checked_at)}</td>
                  </tr>
                ))}
                {upRows.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-graphite">No uptime checks yet — run /api/cron/uptime.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="rounded-2xl border border-mist bg-white p-6">
            <h2 className="text-lg font-bold">Scheduled jobs</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {crons.map((c, i) => (
                <li key={i} className="flex items-center justify-between rounded-lg bg-paper px-3 py-2">
                  <span className="font-semibold">{c.job}</span>
                  <span className="flex items-center gap-3"><span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ${c.ok ? "bg-lime/40 text-forest" : "bg-red-100 text-red-800"}`}>{c.ok ? "ok" : "failed"}</span><span className="text-xs text-graphite">{ago(c.ran_at)}</span></span>
                </li>
              ))}
              {crons.length === 0 && <li className="text-graphite">No cron runs recorded yet.</li>}
            </ul>
          </section>
        </div>

        <section className="rounded-2xl border border-mist bg-white p-6">
          <h2 className="text-lg font-bold">Recent logs</h2>
          <ul className="mt-3 max-h-96 space-y-1 overflow-y-auto font-mono text-xs">
            {logs.map((l) => (
              <li key={l.id} className="flex gap-3 rounded px-2 py-1 hover:bg-paper">
                <span className="shrink-0 text-graphite">{new Date(l.ts).toLocaleTimeString()}</span>
                <span className={`w-14 shrink-0 font-bold uppercase ${l.level === "error" || l.level === "critical" ? "text-red-700" : l.level === "warning" ? "text-amber-700" : "text-graphite"}`}>{l.level}</span>
                <span className="shrink-0 text-forest">{l.service}</span>
                <span className="truncate text-ink">{l.message}{l.route ? <span className="text-graphite"> · {l.route}</span> : null}</span>
              </li>
            ))}
            {logs.length === 0 && <li className="py-4 text-center text-graphite">No logs yet.</li>}
          </ul>
        </section>
      </div>
    </AdminGate>
  );
}
