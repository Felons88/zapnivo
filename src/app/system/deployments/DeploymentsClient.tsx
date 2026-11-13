"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DeploymentRecord } from "@/lib/system/deploy-center";
import type { HealthProfileResult } from "@/lib/system/deploy-health";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const STATE_TONE: Record<string, string> = {
  ready: "bg-lime/15 text-lime ring-lime/30",
  building: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  queued: "bg-sky-400/10 text-sky-300/80 ring-sky-400/20",
  pending: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  awaiting_manual: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  error: "bg-red-500/15 text-red-300 ring-red-400/30",
  canceled: "bg-white/10 text-slate-400 ring-white/15",
  unknown: "bg-white/10 text-slate-400 ring-white/15",
};

const SOURCE_LABEL: Record<string, string> = {
  vercel_api: "vercel api",
  approval_request: "request",
  manual_record: "manual",
};

/**
 * Deployment center table + request-deploy form + rollback requests.
 * All mutations go through /api/system/deployments/* which enforce
 * permissions, change-request approval, and (for production) elevation.
 */
export function DeploymentsClient({
  deployments,
  canManage,
  vercelConfigured,
  rollbackCandidates,
  rollbackProviderConfigured,
  allowedRefs,
  rollbackCompat,
  healthApps,
}: {
  deployments: DeploymentRecord[];
  canManage: boolean;
  vercelConfigured: boolean;
  rollbackCandidates: { uid: string; createdAt: string | null; commitSha: string | null; ageDays?: number | null; compatNote?: string }[];
  rollbackProviderConfigured: boolean;
  allowedRefs: string[];
  healthApps: { app: string; label: string; host: string; checks: number }[];
  rollbackCompat: {
    warning: string;
    repoMigrationCount: number;
    latestMigration: { file: string; number: number | null; title: string } | null;
    dbMigrationTracking: "queryable" | "unavailable";
    appliedCount: number | null;
  } | null;
}) {
  const router = useRouter();
  const [envFilter, setEnvFilter] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ref: allowedRefs[0] ?? "main", env: "preview", justification: "" });
  const [rollbackFor, setRollbackFor] = useState<string | null>(null);
  const [rollbackJustification, setRollbackJustification] = useState("");
  const [rollbackAck, setRollbackAck] = useState(false);
  const [healthApp, setHealthApp] = useState(healthApps[0]?.app ?? "");
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthResult, setHealthResult] = useState<HealthProfileResult | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const filtered = useMemo(
    () => deployments.filter((d) => envFilter === "all" || d.env === envFilter),
    [deployments, envFilter],
  );

  const post = async (url: string, body: Record<string, unknown>, tag: string) => {
    setBusy(tag); setError(null); setNotice(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (res.status === 202) {
        setNotice(`Pending approval — change request ${(j as { changeRequestId?: string }).changeRequestId ?? ""} created; a different principal must approve it first.`);
      } else if (!res.ok) {
        setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      } else {
        setNotice(res.status === 201 ? "Request created." : "Done — history refreshed.");
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const input = "w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 focus:border-lime/40 focus:outline-none";

  const runHealthProfile = async () => {
    if (!healthApp) return;
    setHealthBusy(true); setHealthError(null);
    try {
      const res = await fetch("/api/system/deployments/health-profile", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ app: healthApp }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setHealthError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      else setHealthResult(j as HealthProfileResult);
    } catch {
      setHealthError("request failed — try again");
    } finally {
      setHealthBusy(false);
    }
  };

  return (
    <>
      {/* Request-deploy + rollback controls */}
      {canManage && (
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="eyebrow text-slate-400">API deploy request</h2>
              <p className="mt-1 text-xs text-slate-500">
                Creates an approval-gated deployment request for a git ref. Production is high-risk
                (change-request approval + step-up elevation at execute); preview is medium-risk.
                {!vercelConfigured && " Provider unconfigured — execution resolves to manual steps."}
              </p>
            </div>
            <button type="button" onClick={() => setShowForm((v) => !v)} className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8]">
              {showForm ? "Close" : "New deploy request"}
            </button>
          </div>

          {showForm && (
            <div className="mt-4 grid gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 sm:grid-cols-3">
              <label className="text-[11px] text-slate-500">Git ref
                <input className={input} list="deploy-refs" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} placeholder="main" />
                <datalist id="deploy-refs">
                  {allowedRefs.map((r) => <option key={r} value={r.replace(/\*$/, "")} />)}
                </datalist>
              </label>
              <label className="text-[11px] text-slate-500">Environment
                <select className={input} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })}>
                  <option value="preview">preview</option>
                  <option value="production">production</option>
                </select>
              </label>
              <label className="text-[11px] text-slate-500 sm:col-span-3">Justification (required)
                <textarea className={input} rows={2} value={form.justification} onChange={(e) => setForm({ ...form, justification: e.target.value })} placeholder="What/why — e.g. ship release v1.4.2 to production" />
              </label>
              {error && <p className="font-mono text-xs text-red-300 sm:col-span-3">{error}</p>}
              <div className="sm:col-span-3">
                <button
                  type="button" disabled={busy !== null || form.justification.trim().length < 10}
                  onClick={() => post("/api/system/deployments/request-deploy", { ref: form.ref, env: form.env, justification: form.justification }, "deploy")}
                  className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
                >
                  {busy === "deploy" ? "Submitting…" : "Submit deploy request"}
                </button>
              </div>
            </div>
          )}

          {/* Rollback candidates — migration-compat warning is ALWAYS shown
              and must be explicitly acknowledged (never auto-checked). */}
          {rollbackProviderConfigured && rollbackCandidates.length > 0 && (
            <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Rollback candidates (previous READY production deployments)</h3>
              {rollbackCompat && (
                <div className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] p-3 text-[11px] leading-relaxed text-amber-200/90">
                  <p className="font-bold text-amber-300">⚠ {rollbackCompat.warning}</p>
                  <p className="mt-1 font-mono text-[10px] text-slate-400">
                    repo manifest: {rollbackCompat.repoMigrationCount} migrations
                    {rollbackCompat.latestMigration ? ` (latest: ${rollbackCompat.latestMigration.file} — ${rollbackCompat.latestMigration.title})` : ""}
                    {" · "}db applied-state: {rollbackCompat.dbMigrationTracking === "queryable"
                      ? `queryable (${rollbackCompat.appliedCount ?? "?"} recorded)`
                      : "not tracked per-file via PostgREST — manifest is repo truth"}
                  </p>
                </div>
              )}
              <ul className="mt-2 space-y-2">
                {rollbackCandidates.map((c) => (
                  <li key={c.uid} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-slate-300">{c.uid}</span>
                    <span className="font-mono text-[10px] text-slate-500">{when(c.createdAt)}</span>
                    {c.ageDays != null && <span className="font-mono text-[10px] text-slate-500">({c.ageDays}d old)</span>}
                    {c.commitSha && <span className="font-mono text-[10px] text-slate-500">{c.commitSha.slice(0, 7)}</span>}
                    {canManage && (
                      rollbackFor === c.uid ? (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <input className="w-64 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-slate-200" placeholder="justification (min 10 chars)" value={rollbackJustification} onChange={(e) => setRollbackJustification(e.target.value)} />
                          <label className="inline-flex items-center gap-1.5 font-mono text-[10px] text-amber-300">
                            <input type="checkbox" checked={rollbackAck} onChange={(e) => setRollbackAck(e.target.checked)} className="accent-amber-400" />
                            migrations not reverted — verified
                          </label>
                          <button type="button" disabled={busy !== null || rollbackJustification.trim().length < 10 || !rollbackAck}
                            onClick={() => post("/api/system/deployments/rollback", { deploymentId: c.uid, justification: rollbackJustification, acknowledgeMigrationRisk: true }, `rb-${c.uid}`)}
                            className="rounded-full bg-red-500/15 px-2.5 py-1 font-mono text-[10px] font-bold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-50">confirm rollback</button>
                          <button type="button" onClick={() => { setRollbackFor(null); setRollbackAck(false); }} className="font-mono text-[10px] text-slate-500 hover:text-slate-300">cancel</button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => { setRollbackFor(c.uid); setRollbackJustification(""); setRollbackAck(false); }} className="rounded-full bg-red-500/10 px-2.5 py-1 font-mono text-[10px] font-bold text-red-300 ring-1 ring-red-400/20 hover:bg-red-500/20">request rollback</button>
                      )
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 font-mono text-[10px] text-slate-500">Rollback = promote a previous deployment to production aliases. High-risk: change-request approval + step-up elevation at execute + explicit migration-compat acknowledgement.{rollbackCandidates[0]?.compatNote ? ` ${rollbackCandidates[0].compatNote}` : ""}</p>
            </div>
          )}

          {/* On-demand app health profiles — read-only probes, manage perm */}
          <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">App health profiles</h3>
            <p className="mt-1 text-[11px] text-slate-500">
              Read-only unauthenticated probes per production host (status gates, login redirects, API auth enforcement).
              A degraded result is audited — it never triggers an automatic rollback.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select className={input + " w-auto"} value={healthApp} onChange={(e) => setHealthApp(e.target.value)}>
                {healthApps.map((a) => <option key={a.app} value={a.app}>{a.label} — {a.host} ({a.checks} checks)</option>)}
              </select>
              <button type="button" disabled={healthBusy || !healthApp} onClick={runHealthProfile}
                className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50">
                {healthBusy ? "running…" : "Run health profile"}
              </button>
              {healthError && <span className="font-mono text-[11px] text-red-300">{healthError}</span>}
            </div>
            {healthResult && (
              <div className="mt-3">
                <p className="font-mono text-[11px]">
                  <span className={healthResult.status === "healthy" ? "text-lime" : healthResult.status === "degraded" ? "text-amber-300" : "text-red-300"}>
                    {healthResult.status}
                  </span>
                  <span className="text-slate-500"> · {healthResult.app} ({healthResult.host}) · {healthResult.checksOk}/{healthResult.checksTotal} ok · ran {when(healthResult.ranAt)}</span>
                </p>
                <table className="mt-2 w-full text-left text-[11px]">
                  <thead className="border-b border-white/10 text-[9px] uppercase tracking-wider text-slate-500">
                    <tr>{["Check", "Kind", "Result", "HTTP", "ms", "Detail"].map((h) => <th key={h} className="px-2 py-1.5 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {healthResult.checks.map((c) => (
                      <tr key={c.id} className="border-b border-white/5 last:border-0">
                        <td className="px-2 py-1.5 font-mono">{c.id}{c.critical ? <span className="ml-1 text-red-300">*</span> : null}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-400">{c.kind}</td>
                        <td className="px-2 py-1.5 font-mono font-bold">{c.ok ? <span className="text-lime">ok</span> : <span className="text-red-300">fail</span>}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-300">{c.status ?? "—"}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-400">{c.latencyMs ?? "—"}</td>
                        <td className="max-w-[280px] truncate px-2 py-1.5 font-mono text-slate-500" title={c.detail}>{c.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 font-mono text-[9px] text-slate-600">* = critical check · results also written to uptime_checks + audit</p>
              </div>
            )}
          </div>
          {notice && <p className="mt-3 font-mono text-xs text-lime">{notice}</p>}
        </section>
      )}

      {/* Deployment records */}
      <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
          <h2 className="eyebrow text-slate-400">Deployments</h2>
          <label className="flex items-center gap-2 text-[11px] text-slate-500">
            env
            <select className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-slate-200" value={envFilter} onChange={(e) => setEnvFilter(e.target.value)}>
              <option value="all">all</option>
              <option value="production">production</option>
              <option value="preview">preview</option>
              <option value="development">development</option>
              <option value="unknown">unknown</option>
            </select>
          </label>
        </div>
        {filtered.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-400">
            {deployments.length === 0
              ? "No deployments or requests yet. Provider deployments appear here once VERCEL_TOKEN+VERCEL_PROJECT_ID are configured; approval requests appear as they are created."
              : "No deployments match this environment filter."}
          </p>
        ) : (
          <table className="w-full min-w-[960px] text-left text-xs">
            <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>{["When", "Source", "Env", "State", "Commit", "Branch", "URL", "Reachable", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={`${d.source}:${d.id}`} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-400">{when(d.createdAt)}</td>
                  <td className="px-4 py-3">
                    {d.source === "vercel_api" ? (
                      <Link href={`/system/deployments/${d.id}`} className="font-mono text-[10px] font-bold text-lime hover:underline">{SOURCE_LABEL[d.source]}</Link>
                    ) : (
                      <span className="font-mono text-[10px] text-slate-400">{SOURCE_LABEL[d.source]}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-300">{d.env}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATE_TONE[d.state] ?? STATE_TONE.unknown}`}>
                      {d.state}{d.stateRaw && d.stateRaw !== d.state ? ` (${d.stateRaw})` : ""}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px]">
                    {d.commitUrl ? (
                      <a href={d.commitUrl} target="_blank" rel="noreferrer" className="text-lime hover:underline">{d.commitSha?.slice(0, 7)}</a>
                    ) : d.commitSha ? (
                      <span className="text-slate-400">{d.commitSha.slice(0, 7)}</span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{d.branch ?? "—"}</td>
                  <td className="max-w-[220px] truncate px-4 py-3 font-mono text-[10px]">
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">{d.url.replace(/^https:\/\//, "")}</a>
                    ) : d.inspectorUrl ? (
                      <a href={d.inspectorUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">inspector ↗</a>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px]">
                    {d.reachable === true ? <span className="text-lime">up</span>
                      : d.reachable === false ? <span className="text-red-300">down</span>
                      : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {canManage && d.source === "vercel_api" && d.env === "preview" && d.state === "ready" && d.branch ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        title={`Create a production deploy request for ref '${d.branch}' (approval + elevation required)`}
                        onClick={() => post("/api/system/deployments/request-deploy", {
                          ref: d.branch,
                          env: "production",
                          justification: `Promote preview deployment ${d.id} to production`,
                        }, `promote-${d.id}`)}
                        className="rounded-full bg-lime/10 px-2.5 py-1 font-mono text-[10px] font-bold text-lime ring-1 ring-lime/30 hover:bg-lime/20 disabled:opacity-50"
                      >
                        {busy === `promote-${d.id}` ? "…" : "promote → prod"}
                      </button>
                    ) : (
                      <span className="font-mono text-[10px] text-slate-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="border-t border-white/10 px-5 py-3 text-xs text-slate-500">
          Approval-request rows are managed (approve / execute) on{" "}
          <Link href="/system/app/deployments" className="text-lime hover:underline">App → Deployments</Link>.
          {vercelConfigured ? " Provider execution is live for approved requests." : " Provider unconfigured — execution shows manual instructions."}
        </p>
      </section>
    </>
  );
}
