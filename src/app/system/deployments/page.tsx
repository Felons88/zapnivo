export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listDeployments, rollbackCandidates, rollbackCompatibility } from "@/lib/system/deploy-center";
import { vercelGate, allowedDeployRefs } from "@/lib/system/deploy-provider";
import { deployProviderReadiness, type ProviderReadiness } from "@/lib/system/deploy-verify";
import { listIntegrationStatus, type IntegrationRow } from "@/lib/system/integrations";
import { DeploymentsClient } from "./DeploymentsClient";
import { ProviderReadinessCards, type ProviderCardData } from "./ProviderReadinessCards";

export const metadata: Metadata = { title: "Deployments — Deployment Center" };

function cardData(
  readiness: ProviderReadiness,
  row: IntegrationRow | undefined,
): ProviderCardData {
  const providerMeta = row
    ? { envVars: row.envVars }
    : { envVars: readiness.provider === "vercel" ? ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"] : ["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_DEPLOY_REFS"] };
  return {
    provider: readiness.provider,
    name: readiness.provider === "vercel" ? "Vercel" : "GitHub",
    configured: readiness.configured,
    missing: readiness.missing,
    envPresence: providerMeta.envVars.map((name) => ({ name, set: Boolean(process.env[name]) })),
    lastHealthCheck: row?.lastHealthCheck
      ? {
          status: row.lastHealthCheck.status,
          checkedAt: row.lastHealthCheck.checkedAt,
          latencyMs: row.lastHealthCheck.latencyMs,
          detail: row.lastHealthCheck.detail,
        }
      : null,
    requiredAction: readiness.requiredAction,
  };
}

export default async function DeploymentsCenterPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.deployments.manage");

  const center = await listDeployments(db, { probe: true, limit: 50 });
  const rb = await rollbackCandidates();
  const compat = await rollbackCompatibility(db);
  const vg = vercelGate();
  const integrations = await listIntegrationStatus(db);
  const ghRow = integrations.find((r) => r.id === "github");
  const vcRow = integrations.find((r) => r.id === "vercel");

  const cards: ProviderCardData[] = [
    cardData(deployProviderReadiness("vercel"), vcRow),
    cardData(deployProviderReadiness("github"), ghRow),
  ];

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

        {/* Provider connection readiness — env chips, verified badge, live check */}
        <ProviderReadinessCards providers={cards} />

        <p className="font-mono text-[11px] text-slate-500">
          deploy refs allowed: {allowedDeployRefs().join(", ") || "(none)"} · branch/tag names only (GITHUB_DEPLOY_REFS; trailing-* patterns allowed, raw SHAs only if listed literally)
        </p>

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
          rollbackCompat={{
            warning: compat.warning,
            repoMigrationCount: compat.repoMigrationCount,
            latestMigration: compat.latestMigration,
            dbMigrationTracking: compat.dbMigrationTracking,
            appliedCount: compat.appliedCount,
          }}
        />
      </div>
    </SystemGate>
  );
}
