export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { getDeploymentInfo, getRouteSurfaces } from "@/lib/system/appinfra";

export const metadata: Metadata = { title: "Application infrastructure" };

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Row = ({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) => (
  <div className="flex items-center justify-between gap-4 py-1">
    <dt className="text-slate-500">{k}</dt>
    <dd className={mono ? "font-mono text-xs text-slate-200" : "text-xs text-slate-200"}>{v}</dd>
  </div>
);

export default function AppInfraPage() {
  const d = getDeploymentInfo();
  const surfaces = getRouteSurfaces();

  return (
    <SystemGate perm="system.deployments.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Application</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Application infrastructure</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">checked {new Date(d.checkedAt).toISOString()}</p>
          </div>
          <Link href="/system/app/environments" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
            Environments
          </Link>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Current deployment */}
          <Card title="Current deployment">
            <dl className="divide-y divide-white/5">
              <Row k="VERCEL_ENV" v={d.environment ?? <span className="text-slate-500">not set (local/dev)</span>} />
              <Row k="VERCEL_GIT_COMMIT_SHA" v={d.commitShaShort ? <span title={d.commitSha ?? ""}>{d.commitShaShort}</span> : <span className="text-slate-500">not set</span>} />
              <Row k="VERCEL_URL" v={d.vercelUrl ? `${d.vercelUrl}.vercel.app` : <span className="text-slate-500">not set</span>} />
              <Row k="VERCEL_BRANCH_URL" v={d.branchUrl ? `${d.branchUrl}.vercel.app` : <span className="text-slate-500">not set</span>} />
              <Row k="NEXT_PUBLIC_SITE_URL" v={d.siteUrlConfigured ? "configured" : <span className="text-slate-500">not set</span>} />
            </dl>
            <p className="mt-3 text-xs text-slate-500">
              Values are platform-injected env vars only — no Vercel API is called.
            </p>
          </Card>

          {/* Deployment history */}
          <Card title="Deployment history">
            {d.vercelTokenConfigured ? (
              <p className="text-sm text-slate-300">
                <code className="font-mono">VERCEL_TOKEN</code> is present, but no deployment-history client is implemented
                in this app yet — history is <span className="font-mono">not tracked</span> here.
              </p>
            ) : (
              <p className="text-sm text-slate-300">
                Deployment history requires <code className="font-mono">VERCEL_TOKEN</code> —{" "}
                <span className="font-mono text-amber-300">not configured</span>. Use the Vercel dashboard for deploy
                history; this console does not fabricate it.
              </p>
            )}
            <p className="mt-3 text-xs text-slate-500">
              Cron schedules are declared in <code className="font-mono">vercel.json</code> — see{" "}
              <Link href="/system/jobs" className="text-lime underline">Jobs &amp; workers</Link> for live run status.
            </p>
          </Card>
        </div>

        {/* Route surfaces */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <h2 className="eyebrow text-slate-400">Route surfaces</h2>
          <p className="mt-1 text-xs text-slate-500">
            Host-based routing from <code className="font-mono">src/lib/subdomains.ts</code> (planRoute) — real registry data.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="py-2 pr-4">Host</th>
                  <th className="py-2 pr-4">Path prefix</th>
                  <th className="py-2 pr-4">Surface</th>
                  <th className="py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {surfaces.map((s) => (
                  <tr key={s.host} className="border-b border-white/5 last:border-0">
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-200">{s.host}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-400">{s.pathPrefix}</td>
                    <td className="py-2.5 pr-4 text-xs font-bold text-slate-200">{s.surface}</td>
                    <td className="py-2.5 text-xs text-slate-400">{s.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <p className="font-mono text-[11px] text-slate-500">
          API: environment matrix at <code className="font-mono">/system/app/environments</code>
        </p>
      </div>
    </SystemGate>
  );
}
