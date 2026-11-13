export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { scanApiRoutes } from "@/lib/system/api-inventory";

export const metadata: Metadata = { title: "API inventory" };

const methodTone = (m: string) =>
  m === "GET" ? "bg-lime/15 text-lime ring-lime/30"
  : m === "POST" ? "bg-sky-400/15 text-sky-300 ring-sky-400/30"
  : m === "DELETE" ? "bg-red-500/15 text-red-300 ring-red-400/30"
  : "bg-white/10 text-slate-300 ring-white/15";

/**
 * Filesystem-derived route inventory — every src/app/api/**\/route.ts with the
 * HTTP methods it exports and a heuristic auth label. This is DOCUMENTATION,
 * not a proxy: there is no call tool here (the curated try-it panel lives at
 * /system/dev/api-explorer). Verify auth labels against route source.
 */
export default function ApiInventoryPage() {
  const inv = scanApiRoutes();
  const domains = [...new Set(inv.routes.map((r) => r.domain))].sort();

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Developer Tools / API Inventory</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">API route inventory</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Scanned live from <code className="font-mono">src/app/api/**\/route.ts</code> — {inv.routes.length} routes.
            The auth column is a <strong className="text-amber-300">heuristic</strong> from source markers,
            not enforcement. This page cannot call endpoints — test routes in your own API client or use{" "}
            <a href="/system/dev/api-explorer" className="underline hover:text-white">the curated explorer</a>.
          </p>
        </div>

        {!inv.available ? (
          <p className="rounded-2xl border border-amber-400/20 bg-amber-400/5 px-5 py-6 text-sm text-amber-200">
            Route filesystem unavailable at runtime — the inventory cannot be generated in this
            deployment. Check the repo&apos;s <code className="font-mono">src/app/api</code> directory directly.
          </p>
        ) : (
          domains.map((d) => {
            const routes = inv.routes.filter((r) => r.domain === d);
            return (
              <section key={d} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
                <h2 className="eyebrow text-slate-400">/api/{d} <span className="font-mono text-[10px] text-slate-500">({routes.length})</span></h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                        <th className="py-2 pr-4">Methods</th>
                        <th className="py-2 pr-4">Path</th>
                        <th className="py-2 pr-4">Auth (heuristic)</th>
                        <th className="py-2">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {routes.map((r) => (
                        <tr key={r.path} className="border-b border-white/5 last:border-0">
                          <td className="py-2 pr-4">
                            <span className="inline-flex gap-1">
                              {r.methods.map((m) => (
                                <span key={m} className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ring-1 ${methodTone(m)}`}>{m}</span>
                              ))}
                            </span>
                          </td>
                          <td className="py-2 pr-4 font-mono text-xs text-slate-200">{r.path}</td>
                          <td className="py-2 pr-4 font-mono text-[11px] text-slate-400">{r.auth}</td>
                          <td className="py-2 font-mono text-[10px] text-slate-600">{r.file}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })
        )}
      </div>
    </SystemGate>
  );
}
