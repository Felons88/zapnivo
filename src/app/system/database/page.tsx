export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getDatabaseHealth } from "@/lib/system/database";

export const metadata: Metadata = { title: "Database" };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z";

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default async function DatabasePage() {
  const health = await getDatabaseHealth(serviceClient());
  const okCounts = health.counts.filter((c) => c.count !== null).length;

  return (
    <SystemGate perm="system.database.schema.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Database</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Database overview</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              checked {when(health.checkedAt)} · probe {health.latencyMs == null ? "—" : `${health.latencyMs}ms`}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/system/database/schema" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Schema</Link>
            <Link href="/system/database/migrations" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Migrations</Link>
          </div>
        </div>

        {/* Connectivity */}
        <Card title="Connectivity">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-full px-3 py-1 font-mono text-xs font-bold ring-1 ${
              !health.configured ? "bg-white/10 text-slate-400 ring-white/15"
              : health.reachable ? "bg-lime/15 text-lime ring-lime/30"
              : "bg-red-500/15 text-red-300 ring-red-400/30"
            }`}>
              {!health.configured ? "not configured" : health.reachable ? "reachable" : "unreachable"}
            </span>
            <p className="font-mono text-xs text-slate-400">{health.detail}</p>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Probe is a bounded head-count on <code className="font-mono">system_feature_flags</code> via the service-role
            client. There is intentionally no arbitrary-SQL console on this surface.
          </p>
        </Card>

        {/* Table counts */}
        <Card title={`Key table counts (${okCounts}/${health.counts.length} available)`}>
          {!health.configured ? (
            <p className="text-sm text-slate-400">Backend not configured — counts unavailable.</p>
          ) : health.counts.length === 0 ? (
            <p className="text-sm text-slate-400">No count targets.</p>
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
                  {health.counts.map((c) => (
                    <tr key={c.table} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs text-slate-200">{c.table}</td>
                      <td className="py-2 pr-4 text-xs text-slate-400">{c.label}</td>
                      <td className="py-2 text-right font-mono text-xs">
                        {c.count === null ? (
                          <span className="text-slate-500" title={c.error ?? ""}>unavailable{c.error ? ` (${c.error})` : ""}</span>
                        ) : (
                          <span className="font-bold text-slate-100">{c.count.toLocaleString()}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            <code className="font-mono">stations</code> is not a database table — stations are identified by{" "}
            <code className="font-mono">station_id</code> on kiosks/venues, so no count is shown for it.
          </p>
        </Card>

        {/* Manifest summary */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Schema manifest (repo)">
            <dl className="space-y-1.5 font-mono text-xs">
              <div className="flex justify-between"><dt className="text-slate-500">migrations in repo</dt><dd className="font-bold text-slate-200">{health.manifestMigrationCount}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">tables declared</dt><dd className="font-bold text-slate-200">{health.manifestTableCount}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-slate-500">
              Counts come from <code className="font-mono">src/lib/system/migrations-manifest.json</code> (generated from{" "}
              <code className="font-mono">supabase/migrations/*.sql</code>). Declared ≠ applied — see{" "}
              <Link href="/system/database/migrations" className="text-lime underline">migrations</Link>.
            </p>
          </Card>
          <Card title="API">
            <p className="font-mono text-xs text-slate-400">
              GET /api/system/database/health<br />
              GET /api/system/database/migrations
            </p>
            <p className="mt-3 text-xs text-slate-500">
              Requires <code className="font-mono">system.database.schema.view</code>.
            </p>
          </Card>
        </div>
      </div>
    </SystemGate>
  );
}
