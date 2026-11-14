export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getDatabaseAdmin } from "@/lib/system/db-admin";

export const metadata: Metadata = { title: "Infrastructure · Database" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const BACKUP_LABEL: Record<string, string> = {
  no_verified_backup: "no verified backup",
  backup_configured: "backup configured (PITR only)",
  backup_available: "backup available",
  restore_pending: "restore pending (no passed test)",
  restore_tested: "restore tested (self-reported)",
  recovery_verified: "recovery verified (self-reported)",
};

export default async function InfraDatabasePage() {
  const report = await getDatabaseAdmin(serviceClient());
  const okCounts = report.stats.filter((s) => s.rows !== null).length;

  return (
    <SystemGate perm="system.database.schema.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Infrastructure · Database</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Database administration</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              checked {when(report.checkedAt)} · probe {report.latencyMs == null ? "—" : `${report.latencyMs}ms`}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/system/database" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Overview</Link>
            <Link href="/system/database/schema" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Schema</Link>
            <Link href="/system/database/migrations" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Migrations</Link>
            <Link href="/system/settings/retention" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Retention</Link>
          </div>
        </div>

        {/* Connectivity */}
        <Card title="Connectivity">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-full px-3 py-1 font-mono text-xs font-bold ring-1 ${
              !report.configured ? "bg-white/10 text-slate-400 ring-white/15"
              : report.reachable ? "bg-lime/15 text-lime ring-lime/30"
              : "bg-red-500/15 text-red-300 ring-red-400/30"
            }`}>
              {!report.configured ? "not configured" : report.reachable ? "reachable" : "unreachable"}
            </span>
            <p className="font-mono text-xs text-slate-400">{report.detail}</p>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Probe = bounded head count on <code className="font-mono">system_feature_flags</code> via the service-role
            client. There is intentionally no arbitrary-SQL console on this surface.
          </p>
        </Card>

        {/* Postgres stats — honestly labeled */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Database size">
            <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 font-mono text-[11px] text-amber-200/90">
              unavailable via PostgREST
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">{report.databaseSize.note}</p>
          </Card>
          <Card title="Slow queries">
            <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 font-mono text-[11px] text-amber-200/90">
              requires pg_stat_statements
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">{report.slowQueries.note}</p>
          </Card>
          <Card title="Index health">
            {report.indexHealth.status === "scanned" ? (
              <dl className="space-y-1 font-mono text-xs text-slate-300">
                <div className="flex justify-between"><dt>CREATE INDEX statements (repo)</dt><dd className="font-bold">{report.indexHealth.createIndexStatements}</dd></div>
                <div className="flex justify-between"><dt>tables with RLS (repo scan)</dt><dd className="font-bold">{report.indexHealth.tablesWithRls}</dd></div>
              </dl>
            ) : (
              <p className="text-xs text-slate-400">{report.indexHealth.note}</p>
            )}
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              {report.indexHealth.status === "scanned" ? report.indexHealth.note : ""}
            </p>
            <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 font-mono text-[11px] text-amber-200/90">
              live index usage: unavailable via PostgREST
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">{report.indexUsage.note}</p>
          </Card>
        </div>

        {/* Live catalog internals — honest unavailable pair */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Table sizes">
            <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 font-mono text-[11px] text-amber-200/90">
              unavailable via PostgREST
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">{report.tableSizes.note}</p>
          </Card>
          <Card title="Storage growth">
            <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-slate-300">
              {report.storageGrowth.status}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">{report.storageGrowth.note}</p>
          </Card>
        </div>

        {/* Table counts */}
        <Card title={`Key table row counts (${okCounts}/${report.stats.length} available)`}>
          {!report.configured ? (
            <p className="text-sm text-slate-400">Backend not configured — counts unavailable.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">Table</th>
                    <th className="py-2 pr-4">Description</th>
                    <th className="py-2 text-right">Rows (exact head count)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.stats.map((s) => (
                    <tr key={s.table} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs text-slate-200">{s.table}</td>
                      <td className="py-2 pr-4 text-xs text-slate-400">{s.label}</td>
                      <td className="py-2 text-right font-mono text-xs">
                        {s.rows === null ? (
                          <span className="text-slate-500" title={s.error ?? ""}>unavailable{s.error ? ` (${s.error})` : ""}</span>
                        ) : (
                          <span className="font-bold text-slate-100">{s.rows.toLocaleString()}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Head counts are exact but unbounded in cost on huge tables — this is a deliberate trade-off for an
            internal admin surface; each count is a single <code className="font-mono">count: exact, head: true</code> query.
          </p>
        </Card>

        {/* Row estimates (planner) + freshness */}
        {report.rowEstimates && (
          <Card title={`Row estimates — planner estimate, ${report.rowEstimates.tablesWithEstimate}/${report.rowEstimates.tablesProbed} tables (${report.rowEstimates.status})`}>
            {!report.configured ? (
              <p className="text-sm text-slate-400">Backend not configured — estimates unavailable.</p>
            ) : report.rowEstimates.status === "unavailable" ? (
              <p className="text-sm text-slate-400">No estimates returned — every probe failed or the manifest is empty.</p>
            ) : (
              <>
                <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-slate-300">
                  <div className="flex gap-2"><dt className="text-slate-500">est. total rows (manifest tables)</dt><dd className="font-bold">{report.rowEstimates.estimatedTotalRows == null ? "—" : `≈${report.rowEstimates.estimatedTotalRows.toLocaleString()}`}</dd></div>
                  <div className="flex gap-2"><dt className="text-slate-500">tables probed</dt><dd className="font-bold">{report.rowEstimates.tablesProbed}</dd></div>
                </dl>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                        <th className="py-2 pr-4">Largest tables (estimate)</th>
                        <th className="py-2 text-right">Est. rows</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.rowEstimates.largest.map((r) => (
                        <tr key={r.table} className="border-b border-white/5 last:border-0">
                          <td className="py-2 pr-4 font-mono text-xs text-slate-200">{r.table}</td>
                          <td className="py-2 text-right font-mono text-xs font-bold text-slate-100">≈{r.estimate.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer font-mono text-[11px] text-slate-500 hover:text-slate-300">all {report.rowEstimates.rows.length} estimates</summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[420px] text-left text-xs">
                      <tbody>
                        {report.rowEstimates.rows.map((r) => (
                          <tr key={r.table} className="border-b border-white/5 last:border-0">
                            <td className="py-1 pr-4 font-mono text-slate-300">{r.table}</td>
                            <td className="py-1 text-right font-mono">
                              {r.estimate === null ? <span className="text-slate-500" title={r.error ?? ""}>unavailable</span> : <span className="text-slate-200">≈{r.estimate.toLocaleString()}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
            <p className="mt-3 text-xs leading-relaxed text-slate-500">{report.rowEstimates.note}</p>
          </Card>
        )}

        <Card title="Data freshness — newest row per pipeline table">
          {!report.configured || report.freshness.length === 0 ? (
            <p className="text-sm text-slate-400">Backend not configured — freshness unavailable.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">Table</th>
                    <th className="py-2 pr-4">Column</th>
                    <th className="py-2 text-right">Last write (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.freshness.map((f) => (
                    <tr key={f.table} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4 text-xs text-slate-300">{f.label}<span className="ml-2 font-mono text-[10px] text-slate-500">{f.table}</span></td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-500">{f.column}</td>
                      <td className="py-2 text-right font-mono text-xs">
                        {!f.probed ? (
                          <span className="text-slate-500" title={f.error ?? ""}>unavailable{f.error ? ` (${f.error})` : ""}</span>
                        ) : f.lastAt === null ? (
                          <span className="text-slate-500">empty</span>
                        ) : (
                          <span className="text-slate-200">{when(f.lastAt)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            One ordered <code className="font-mono">limit 1</code> select per table on an indexed timestamp column —
            a liveness signal for write pipelines (cron, webhooks, device ingest, audit), not a throughput measure.
          </p>
        </Card>

        {/* Migrations + RLS */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Migration history (repo)">
            <dl className="space-y-1.5 font-mono text-xs">
              <div className="flex justify-between"><dt className="text-slate-500">migrations in repo</dt><dd className="font-bold text-slate-200">{report.migrations.repoMigrationCount}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">latest file</dt><dd className="font-bold text-slate-200">{report.migrations.repoLatestFile ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">tables declared</dt><dd className="font-bold text-slate-200">{report.migrations.repoTableCount}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">remote applied-through</dt><dd className="font-bold text-amber-300">untracked via PostgREST</dd></div>
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-slate-500">{report.migrations.note}</p>
            <p className="mt-2 font-mono text-[11px] text-slate-500">
              full list → <Link className="text-lime underline" href="/system/database/migrations">/system/database/migrations</Link>
            </p>
          </Card>

          <Card title="RLS coverage (repo scan)">
            {report.rls.status === "scanned" ? (
              <>
                <dl className="space-y-1.5 font-mono text-xs">
                  <div className="flex justify-between"><dt className="text-slate-500">manifest tables</dt><dd className="font-bold text-slate-200">{report.rls.manifestTables}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">tables with RLS enabled</dt><dd className="font-bold text-slate-200">{report.rls.rlsEnabledTables}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">manifest tables w/o RLS stmt</dt><dd className={`font-bold ${report.rls.uncoveredTables.length ? "text-amber-300" : "text-lime"}`}>{report.rls.uncoveredTables.length}</dd></div>
                </dl>
                {report.rls.uncoveredTables.length > 0 && (
                  <p className="mt-2 font-mono text-[11px] text-amber-200/80">{report.rls.uncoveredTables.join(", ")}</p>
                )}
                <p className="mt-3 text-xs leading-relaxed text-slate-500">{report.rls.note}</p>
              </>
            ) : (
              <p className="text-sm text-slate-400">{report.rls.note}</p>
            )}
          </Card>
        </div>

        {/* Backup + retention */}
        <Card title="Backup & retention">
          {report.backup ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">backup state</p>
                <p className="mt-1 font-mono text-sm font-bold text-slate-100">
                  {report.backup.state ? BACKUP_LABEL[report.backup.state] ?? report.backup.state : "unknown"}
                </p>
                {report.backup.providerSnapshot && (
                  <p className="mt-1 font-mono text-[11px] text-slate-400">
                    provider snapshot as_of {report.backup.providerSnapshot.as_of} · region {report.backup.providerSnapshot.region ?? "?"} · pitr={String(report.backup.providerSnapshot.pitr_enabled)} · backups={report.backup.providerSnapshot.backup_count ?? "?"}
                  </p>
                )}
                {report.backup.recoveryLastTest && (
                  <p className="mt-1 font-mono text-[11px] text-slate-400">
                    last recovery test: {report.backup.recoveryLastTest.result ?? "?"} ({report.backup.recoveryLastTest.tested_at ?? "?"}) — self-reported
                  </p>
                )}
              </div>
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">retention last run</p>
                {report.backup.retentionLastRun ? (
                  <p className="mt-1 font-mono text-sm font-bold text-slate-100">
                    {report.backup.retentionLastRun.status ?? "?"} · {report.backup.retentionLastRun.mode ?? "?"} · {when(report.backup.retentionLastRun.created_at)}
                  </p>
                ) : (
                  <p className="mt-1 font-mono text-sm text-slate-400">no runs recorded</p>
                )}
                <p className="mt-2 text-xs text-slate-500">
                  Full state machine + provider snapshot detail: <Link className="text-lime underline" href="/system/security/readiness">/system/security/readiness</Link> ·{" "}
                  retention policy: <Link className="text-lime underline" href="/system/settings/retention">/system/settings/retention</Link>
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-400">Backup probe unavailable — backend not configured or readiness aggregate failed.</p>
          )}
          {report.backup?.note && <p className="mt-3 text-xs leading-relaxed text-slate-500">{report.backup.note}</p>}
        </Card>

        <p className="text-xs text-slate-500">
          API: <code className="font-mono">GET /api/system/infrastructure/database</code> · perm{" "}
          <code className="font-mono">system.database.schema.view</code>
        </p>
      </div>
    </SystemGate>
  );
}
