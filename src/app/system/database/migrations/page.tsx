export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { githubBlobUrl, MANIFEST_NOTE, MIGRATIONS } from "@/lib/system/database";

export const metadata: Metadata = { title: "Database migrations" };

export default function MigrationsPage() {
  return (
    <SystemGate perm="system.database.schema.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-lime">Database / Migrations</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Migration history</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            {MIGRATIONS.length} migration files in <code className="font-mono">supabase/migrations/</code>, listed in repo
            (apply) order.
          </p>
        </div>

        <p className="rounded-xl border border-white/[0.08] bg-white/[0.05] px-4 py-3 text-sm text-slate-300">
          Migrations are applied via <code className="font-mono">supabase db push</code> during reviewed deploys — there is
          no per-file remote tracking, so every row is labeled{" "}
          <span className="font-mono text-xs">in repo · remote state unverified per-file</span>. {MANIFEST_NOTE}
        </p>

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="py-2 pr-4">#</th>
                  <th className="py-2 pr-4">File</th>
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Tables created</th>
                  <th className="py-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {MIGRATIONS.map((m) => (
                  <tr key={m.file} className="border-b border-white/5 last:border-0 align-top">
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-500">{m.number ?? "—"}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">
                      <a
                        href={githubBlobUrl(m.file)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-lime underline decoration-lime/40 hover:decoration-lime"
                      >
                        {m.file}
                      </a>
                    </td>
                    <td className="max-w-[280px] py-2.5 pr-4">
                      <p className="text-xs font-bold text-slate-200">{m.title}</p>
                      {m.description && <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{m.description}</p>}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-[11px] text-slate-400">
                      {m.tables.length === 0 ? "—" : `${m.tables.length} table${m.tables.length === 1 ? "" : "s"}`}
                      {m.tables.length > 0 && (
                        <span className="block max-w-[220px] truncate text-slate-600" title={m.tables.join(", ")}>
                          {m.tables.join(", ")}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-400 ring-1 ring-white/15">
                        in repo · remote unverified
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <p className="font-mono text-[11px] text-slate-500">
          API: GET /api/system/database/migrations · source: supabase/migrations/*.sql → migrations-manifest.json
        </p>
      </div>
    </SystemGate>
  );
}
