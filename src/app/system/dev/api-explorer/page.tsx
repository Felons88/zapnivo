export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { API_CATALOG, API_DOMAINS, PING_ALLOWLIST } from "@/lib/system/devtools";
import { TryIt } from "./TryIt";

export const metadata: Metadata = { title: "API Explorer" };

const methodTone = (m: string) =>
  m === "GET" ? "bg-lime/15 text-lime ring-lime/30"
  : m === "POST" ? "bg-sky-400/15 text-sky-300 ring-sky-400/30"
  : "bg-white/10 text-slate-300 ring-white/15";

export default function ApiExplorerPage() {
  const byDomain = API_DOMAINS.map((d) => ({
    domain: d,
    endpoints: API_CATALOG.filter((e) => e.domain === d),
  }));

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Developer Tools / API Explorer</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">API endpoint directory</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Hand-curated catalog of Zapnivo API routes (the filesystem isn&apos;t reliably available at runtime,
            so this list is maintained in <code className="font-mono">src/lib/system/devtools.ts</code> — verify
            against <code className="font-mono">src/app/api</code> before relying on it). Auth column describes
            the real gate each route enforces.
          </p>
        </div>

        {/* Try-it panel */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <h2 className="eyebrow text-slate-400">Try it — safe GET proxy</h2>
          <p className="mt-1 text-xs text-slate-400">
            Sends a GET through <code className="font-mono">POST /api/system/dev/ping</code>, which only proxies
            the allowlisted read-only endpoints below using <em>your</em> session — upstream permission checks
            still apply. No arbitrary URLs, no POST bodies, no custom headers. Rate limit: 30/min per user.
          </p>
          <TryIt allowlist={PING_ALLOWLIST} />
        </section>

        {byDomain.map(({ domain, endpoints }) => (
          <section key={domain} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
            <h2 className="eyebrow text-slate-400">{domain}</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">Method</th>
                    <th className="py-2 pr-4">Path</th>
                    <th className="py-2 pr-4">Auth</th>
                    <th className="py-2">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {endpoints.map((e) => (
                    <tr key={`${e.method} ${e.path}`} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4">
                        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ring-1 ${methodTone(e.method)}`}>{e.method}</span>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-200">{e.path}</td>
                      <td className="py-2 pr-4 font-mono text-[11px] text-slate-400">{e.auth}</td>
                      <td className="py-2 text-xs text-slate-400">{e.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        <p className="text-xs text-slate-500">
          API: <code className="font-mono">GET /api/system/dev/endpoints</code> ·{" "}
          <code className="font-mono">POST /api/system/dev/ping</code>
        </p>
      </div>
    </SystemGate>
  );
}
