export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { scanApiInventory, attachRouteErrors, type RouteEntry } from "./inventory";

export const metadata: Metadata = { title: "Infrastructure · API services" };

const AUTH_TONE: Record<RouteEntry["auth"], string> = {
  system_rbac: "bg-lime/15 text-lime ring-lime/30",
  cron_secret: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  device_ingest: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  provider_webhook: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  session: "bg-white/10 text-slate-200 ring-white/20",
  staff: "bg-white/10 text-slate-200 ring-white/20",
  partner: "bg-white/10 text-slate-200 ring-white/20",
  support_token: "bg-white/10 text-slate-200 ring-white/20",
  dev_only: "bg-fuchsia-400/15 text-fuchsia-300 ring-fuchsia-400/30",
  public_or_unclassified: "bg-red-500/10 text-red-300/80 ring-red-400/20",
};

const AUTH_LABEL: Record<RouteEntry["auth"], string> = {
  system_rbac: "system RBAC",
  cron_secret: "cron secret",
  device_ingest: "device auth",
  provider_webhook: "provider webhook",
  session: "session",
  staff: "staff",
  partner: "partner",
  support_token: "support token",
  dev_only: "dev only",
  public_or_unclassified: "unclassified",
};

export default async function ApiServicesPage() {
  const inventory = scanApiInventory();
  await attachRouteErrors(serviceClient(), inventory.routes);
  const byDomain = new Map<string, RouteEntry[]>();
  for (const r of inventory.routes) {
    const list = byDomain.get(r.domain) ?? [];
    list.push(r);
    byDomain.set(r.domain, list);
  }

  return (
    <SystemGate perm="system.integrations.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Infrastructure · API services</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">API route inventory</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            {inventory.routeCount} route handlers scanned live from <code className="font-mono">src/app/api/**/route.ts</code>.
            Auth is classified by guard tokens detected in each route&apos;s source —{" "}
            <span className="font-mono">unclassified</span> means no guard was statically detected, NOT that the
            route is public. This is inventory, not uptime monitoring.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {inventory.domains.map((d) => (
            <div key={d.domain} className="rounded-xl border border-white/[0.08] bg-white/[0.05] p-4">
              <p className="font-mono text-sm font-bold text-slate-100">/api/{d.domain}</p>
              <p className="mt-1 font-mono text-[11px] text-slate-500">{d.routes} route{d.routes === 1 ? "" : "s"}</p>
            </div>
          ))}
        </div>

        {[...byDomain.entries()].map(([domain, routes]) => (
          <section key={domain} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">
              /api/{domain} <span className="text-slate-600">({routes.length})</span>
            </h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">Route</th>
                    <th className="py-2 pr-4">Methods</th>
                    <th className="py-2 pr-4">Auth (heuristic)</th>
                    <th className="py-2 pr-4">Auth detail</th>
                    <th className="py-2 text-right">Errors 24h / recent</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((r) => (
                    <tr key={r.path} className="border-b border-white/5 align-top last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs text-slate-200">{r.path.replace(/^\/api\//, "")}</td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap gap-1">
                          {r.methods.map((m) => (
                            <span key={m} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 ring-1 ring-white/10">{m}</span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${AUTH_TONE[r.auth]}`} title={r.authSource === "heuristic" ? "path heuristic — guard not detected in source" : "guard detected in route source"}>
                          {AUTH_LABEL[r.auth]}
                        </span>
                        {r.authSource === "heuristic" && <span className="ml-1 font-mono text-[9px] text-slate-600">~</span>}
                      </td>
                      <td className="max-w-[300px] py-2 pr-4 font-mono text-[11px] leading-snug text-slate-500">{r.authDetail}</td>
                      <td className="py-2 text-right font-mono text-xs">
                        {r.errors24h == null ? <span className="text-slate-600">—</span> : (
                          <span className={r.errors24h > 0 ? "font-bold text-red-300" : "text-slate-500"}>
                            {r.errors24h} / {r.errorsRecent ?? 0}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        <p className="text-xs leading-relaxed text-slate-500">
          {inventory.note} Error counts come from <code className="font-mono">error_events.route</code> labels
          (free-form — a route with 0 may simply never have reported under that label). Scanned{" "}
          {new Date(inventory.generatedAt).toLocaleString("en-US", { timeZone: "UTC" })}Z.
        </p>
        <p className="font-mono text-[11px] text-slate-600">
          API: GET /api/system/infrastructure/api-services · perm system.integrations.view
        </p>
      </div>
    </SystemGate>
  );
}
