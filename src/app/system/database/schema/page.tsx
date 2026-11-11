export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getCatalogCounts, getDatabaseHealth, MANIFEST_NOTE, MANIFEST_TABLES, MIGRATIONS, TABLE_CATALOG } from "@/lib/system/database";

export const metadata: Metadata = { title: "Database schema" };

const countTone = (c: number | null, live: boolean) =>
  !live ? "bg-white/10 text-slate-500 ring-white/15"
  : c === null ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
  : "bg-white/5 text-slate-200 ring-white/10";

export default async function SchemaPage() {
  const db = serviceClient();
  const health = await getDatabaseHealth(db);
  const counts = await getCatalogCounts(db);
  const liveCount = TABLE_CATALOG.filter((c) => c.live && counts.get(c.table) != null).length;

  return (
    <SystemGate perm="system.database.schema.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-lime">Database / Schema</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Schema registry</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            {MIGRATIONS.length} migrations in repo · {MANIFEST_TABLES.length} tables declared ·{" "}
            {liveCount}/{TABLE_CATALOG.filter((c) => c.live).length} catalog tables have live counts.
          </p>
        </div>

        <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          <strong>No arbitrary SQL.</strong> This console never accepts or runs free-form queries — the only DB access is
          bounded head-count probes via the service-role client. {MANIFEST_NOTE}
        </p>

        {/* Table catalog */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="eyebrow text-slate-400">Table catalog</h2>
            <p className="font-mono text-[10px] text-slate-500">counts: live head-count vs catalog only</p>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="py-2 pr-4">Table</th>
                  <th className="py-2 pr-4">Purpose</th>
                  <th className="py-2 text-right">Rows</th>
                  <th className="py-2 pl-4 text-right">Source</th>
                </tr>
              </thead>
              <tbody>
                {TABLE_CATALOG.map((c) => {
                  const count = c.live ? (counts.get(c.table) ?? null) : null;
                  const source = !c.live ? "catalog only" : count === null ? "unavailable" : "live";
                  return (
                    <tr key={c.table} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs text-slate-200">{c.table}</td>
                      <td className="py-2 pr-4 text-xs text-slate-400">{c.purpose}</td>
                      <td className="py-2 text-right">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold ring-1 ${countTone(count, c.live)}`}>
                          {count === null ? "—" : count.toLocaleString()}
                        </span>
                      </td>
                      <td className="py-2 pl-4 text-right font-mono text-[10px] text-slate-500">{source}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Full declared-table list ({MANIFEST_TABLES.length}):{" "}
            <span className="font-mono">{MANIFEST_TABLES.join(", ")}</span>. Declared tables come from the repo manifest —
            presence in the manifest does not prove the table exists remotely.
          </p>
          {!health.configured && (
            <p className="mt-2 text-xs text-amber-300">Backend not configured — all live counts unavailable.</p>
          )}
        </section>

        {/* Migration list (compact — full history on /system/database/migrations) */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="eyebrow text-slate-400">Migrations</h2>
            <Link href="/system/database/migrations" className="text-xs font-bold text-lime underline">full history →</Link>
          </div>
          <ul className="mt-3 divide-y divide-white/5">
            {MIGRATIONS.map((m) => (
              <li key={m.file} className="flex items-baseline justify-between gap-4 py-2 text-xs">
                <span className="min-w-0">
                  <span className="font-mono font-bold text-slate-200">{m.file}</span>{" "}
                  <span className="text-slate-400">{m.title}</span>
                </span>
                <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-400 ring-1 ring-white/15">
                  in repo · remote unverified
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </SystemGate>
  );
}
