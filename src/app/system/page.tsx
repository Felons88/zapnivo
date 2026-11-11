export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSystemOverview } from "@/lib/system/overview";

export const metadata: Metadata = { title: "Command Center" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const statusTone = (s: string) =>
  s === "active" ? "bg-lime/15 text-lime ring-lime/30"
  : s === "quarantined" || s === "suspended" ? "bg-red-500/15 text-red-300 ring-red-400/30"
  : s === "maintenance" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
  : "bg-white/10 text-slate-300 ring-white/15";

export default async function SystemOverviewPage() {
  const db = serviceClient();
  const o = await getSystemOverview(db);
  const enabledFlags = o.flags.filter((f) => f.enabled).length;

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Command Center</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">System overview</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">env: {o.environment} · data: {o.configured ? "live" : "backend not configured"}</p>
          </div>
          <div className="flex gap-2">
            <Link href="/system/security/audit" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Audit log</Link>
            <Link href="/system/changes" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Change requests</Link>
            <Link href="/system/settings/flags" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Feature flags</Link>
          </div>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Card title="Devices"><p className="font-mono text-3xl font-bold">{o.devices.total ?? "—"}</p><p className="mt-1 text-xs text-slate-400">registered in system_devices</p></Card>
          <Card title="Active devices"><p className="font-mono text-3xl font-bold">{o.devices.byStatus.active ?? 0}</p><p className="mt-1 text-xs text-slate-400">of {Object.keys(o.devices.byStatus).length} status buckets</p></Card>
          <Card title="Pending changes"><p className="font-mono text-3xl font-bold text-amber-300">{o.changes.pending ?? "—"}</p><p className="mt-1 text-xs text-slate-400"><Link href="/system/changes" className="underline hover:text-white">awaiting decision</Link></p></Card>
          <Card title="Feature flags"><p className="font-mono text-3xl font-bold">{enabledFlags}<span className="text-base text-slate-400">/{o.flags.length}</span></p><p className="mt-1 text-xs text-slate-400">enabled (metadata only)</p></Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Device status breakdown */}
          <Card title="Device status">
            {Object.keys(o.devices.byStatus).length === 0 ? (
              <p className="text-sm text-slate-400">No devices registered yet. Fleet onboarding lands in a later stage.</p>
            ) : (
              <ul className="space-y-2">
                {Object.entries(o.devices.byStatus).sort().map(([s, n]) => (
                  <li key={s} className="flex items-center justify-between text-sm">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${statusTone(s)}`}>{s}</span>
                    <span className="font-mono font-bold">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Payments readiness (reused from admin pipeline) */}
          <Card title="Payments readiness">
            {!o.payments ? <p className="text-sm text-slate-400">Unknown — backend not configured.</p> : (
              <dl className="space-y-1.5 font-mono text-xs">
                <Row k="stripe" v={`${o.payments.stripe.secretKey ? "key ✓" : "key ✗"} · ${o.payments.stripe.webhookSecret ? "whsec ✓" : "whsec ✗"} · ${o.payments.stripe.mode}`} />
                <Row k="products" v={`plans ${o.payments.products.plans ?? "?"} · packages ${o.payments.products.packages ?? "?"}`} />
                <Row k="gifts" v={o.payments.gifts} />
                <Row k="kiosk" v={o.payments.kiosk} />
                <Row k="reconciliation" v={o.payments.reconciliation} />
                <Row k="overall" v={o.payments.overall} strong />
              </dl>
            )}
          </Card>

          {/* Recent audit */}
          <Card title="Recent system activity">
            {o.audit.recent.length === 0 ? <p className="text-sm text-slate-400">No system audit events yet.</p> : (
              <ul className="space-y-2">
                {o.audit.recent.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate"><span className="font-mono font-bold text-lime">{a.action}</span> <span className="text-slate-400">{a.resource}</span></span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-500">{when(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Recent devices */}
        <Card title="Recently registered devices">
          {o.devices.recent.length === 0 ? <p className="text-sm text-slate-400">None yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>{["UID", "Serial", "Model", "Status", "Last heartbeat"].map((h) => <th key={h} className="pb-2 pr-4 font-extrabold">{h}</th>)}</tr></thead>
                <tbody className="font-mono">
                  {o.devices.recent.map((d) => (
                    <tr key={d.id} className="border-t border-white/5">
                      <td className="py-2 pr-4 text-slate-300">{d.device_uid ?? "—"}</td>
                      <td className="py-2 pr-4">{d.serial_number ?? "—"}</td>
                      <td className="py-2 pr-4">{d.model ?? "—"}</td>
                      <td className="py-2 pr-4"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${statusTone(d.status)}`}>{d.status}</span></td>
                      <td className="py-2 text-slate-400">{when(d.last_heartbeat_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Recent change requests */}
        <Card title="Recent change requests">
          {o.changes.recent.length === 0 ? <p className="text-sm text-slate-400">None yet.</p> : (
            <ul className="divide-y divide-white/5">
              {o.changes.recent.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-4 py-2.5 text-xs">
                  <div className="min-w-0">
                    <span className="font-mono font-bold text-slate-200">{c.action}</span>
                    <span className="ml-2 text-slate-500">{c.environment} · {c.risk} risk</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${c.status === "approved" ? "bg-lime/15 text-lime ring-lime/30" : c.status === "pending" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30" : c.status === "rejected" ? "bg-red-500/15 text-red-300 ring-red-400/30" : "bg-white/10 text-slate-300 ring-white/15"}`}>{c.status}</span>
                    <span className="font-mono text-[10px] text-slate-500">{when(c.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </SystemGate>
  );
}

function Row({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-slate-500">{k}</dt>
      <dd className={strong ? "font-bold text-lime" : "text-slate-200"}>{v}</dd>
    </div>
  );
}
