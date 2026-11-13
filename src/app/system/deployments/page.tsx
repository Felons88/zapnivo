export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listDeployments, rollbackCandidates } from "@/lib/system/deploy-center";
import { vercelGate, githubGate, allowedDeployRefs } from "@/lib/system/deploy-provider";
import { DeploymentsClient } from "./DeploymentsClient";

export const metadata: Metadata = { title: "Deployments — Deployment Center" };

export default async function DeploymentsCenterPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.deployments.manage");

  const center = await listDeployments(db, { probe: true, limit: 50 });
  const rb = await rollbackCandidates();
  const vg = vercelGate();
  const gg = githubGate();

  return (
    <SystemGate perm="system.deployments.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Deployment Center</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Deployments</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Live provider deployments merged with the approval-gated request workflow.
              {vg.configured
                ? " Vercel API is configured — approved requests execute through the provider."
                : " Vercel API is not configured — approved requests resolve to awaiting_manual_deploy with exact manual steps."}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/system/deployments/github" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
              GitHub view →
            </Link>
            <Link href="/system/app/deployments" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
              ← App deployments
            </Link>
          </div>
        </div>

        {/* Provider configuration banners — honest, no secrets */}
        <div className="grid gap-3 sm:grid-cols-2">
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-4">
            <h2 className="eyebrow text-slate-400">Vercel provider</h2>
            {vg.configured ? (
              <p className="mt-2 font-mono text-xs text-lime">configured — deployments, events, promote &amp; cancel via API</p>
            ) : (
              <div className="mt-2 space-y-1 text-xs text-slate-400">
                <p><span className="font-mono text-amber-300">requires_credentials</span> — set <code className="font-mono">VERCEL_TOKEN</code> + <code className="font-mono">VERCEL_PROJECT_ID</code> (optional <code className="font-mono">VERCEL_TEAM_ID</code>) to enable API execution.</p>
                <p className="font-mono text-[11px] text-slate-500">missing: {vg.missing.join(", ")}</p>
              </div>
            )}
          </section>
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-4">
            <h2 className="eyebrow text-slate-400">GitHub provider</h2>
            {gg.configured ? (
              <p className="mt-2 font-mono text-xs text-lime">configured — repo, commits, branches, PRs &amp; checks</p>
            ) : (
              <div className="mt-2 space-y-1 text-xs text-slate-400">
                <p><span className="font-mono text-amber-300">requires_credentials</span> — set <code className="font-mono">GITHUB_TOKEN</code> + <code className="font-mono">GITHUB_REPO=owner/name</code> for commit links and the GitHub view.</p>
                <p className="font-mono text-[11px] text-slate-500">missing: {gg.missing.join(", ")}</p>
              </div>
            )}
            <p className="mt-2 font-mono text-[11px] text-slate-500">
              deploy refs allowed: {allowedDeployRefs().join(", ") || "(none)"} · set GITHUB_DEPLOY_REFS to widen
            </p>
          </section>
        </div>

        {center.vercelError && (
          <p className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-2 font-mono text-xs text-red-300">
            Vercel API error: {center.vercelError}
          </p>
        )}

        <DeploymentsClient
          deployments={center.deployments}
          canManage={canManage}
          vercelConfigured={vg.configured}
          rollbackCandidates={rb.configured && rb.ok ? rb.candidates.map((d) => ({
            uid: d.uid,
            createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
            commitSha: d.commitSha,
          })) : []}
          rollbackProviderConfigured={rb.configured}
          allowedRefs={allowedDeployRefs()}
        />
      </div>
    </SystemGate>
  );
}
