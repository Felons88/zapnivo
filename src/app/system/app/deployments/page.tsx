export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getDeploymentInfo } from "@/lib/system/appinfra";
import { listDeploymentRequests, type DeploymentRequestRow } from "@/lib/system/deployops";
import { DeploymentControls } from "./DeploymentControls";

export const metadata: Metadata = { title: "Application — Deployments" };

export default async function DeploymentsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.deployments.manage");
  const d = getDeploymentInfo();
  const { requests, error: requestsError } = db
    ? await listDeploymentRequests(db, 100)
    : { requests: [] as DeploymentRequestRow[], error: "backend not configured" };

  return (
    <SystemGate perm="system.deployments.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Application</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Deployments</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Request → approve → <span className="font-mono">awaiting_manual_deploy</span>. This console never calls a
              deployment API — approved requests resolve to manual deploy via git push / the Vercel dashboard.
            </p>
          </div>
          <Link href="/system/app" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
            ← App infra
          </Link>
        </div>

        {/* Current deployment */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <h2 className="eyebrow text-slate-400">Current deployment</h2>
          <dl className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
            {[
              ["VERCEL_ENV", d.environment ?? "not set (local/dev)"],
              ["VERCEL_GIT_COMMIT_SHA", d.commitShaShort ? `${d.commitShaShort}…` : "not set"],
              ["VERCEL_URL", d.vercelUrl ? `${d.vercelUrl}.vercel.app` : "not set"],
              ["VERCEL_TOKEN", d.vercelTokenConfigured ? "configured (unused — no deploy client)" : "not configured"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 py-1">
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-mono text-xs text-slate-200">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-500">Platform-injected env vars only — no Vercel API is called. History below is the request workflow, not provider deploy history.</p>
        </section>

        <DeploymentControls
          canManage={canManage}
          currentUserId={user?.id ?? null}
          requests={requests}
          backendConfigured={Boolean(db)}
          requestsError={requestsError}
        />

        <p className="font-mono text-[11px] text-slate-500">
          API: <code className="font-mono">/api/system/deployments</code> · decisions at{" "}
          <code className="font-mono">/api/system/deployments/[id]/decision</code> · execute at{" "}
          <code className="font-mono">/api/system/deployments/[id]/execute</code>
        </p>
      </div>
    </SystemGate>
  );
}
