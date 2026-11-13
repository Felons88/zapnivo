export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getDeploymentDetail, githubCommitUrl, manualDeployInstructions, type DeploymentHealth } from "@/lib/system/deploy-center";
import { vercelGate } from "@/lib/system/deploy-provider";
import { DeploymentMonitor } from "./DeploymentMonitor";

export const metadata: Metadata = { title: "Deployment detail" };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

export default async function DeploymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = serviceClient();
  const detail = await getDeploymentDetail(db, id);
  if (!detail) notFound();

  const d = detail.deployment;
  const req = detail.request;
  const vg = vercelGate();
  const commitUrl = d?.commitSha ? githubCommitUrl(d.commitSha) : null;
  const reqResult = (typeof req?.result === "object" && req?.result ? req.result : {}) as Record<string, unknown>;
  const initialHealth = (typeof reqResult.health === "object" && reqResult.health ? reqResult.health : null) as DeploymentHealth | null;

  return (
    <SystemGate perm="system.deployments.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Deployment Center</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Deployment {id.slice(0, 12)}…</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              {d ? `Vercel deployment · ${d.readyState ?? "unknown state"}` : req ? `Deployment request · ${req.status}` : "Detail"}
            </p>
          </div>
          <Link href="/system/deployments" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
            ← Deployments
          </Link>
        </div>

        {/* Deployment facts */}
        {d && (
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Deployment</h2>
            <dl className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
              {[
                ["uid", d.uid],
                ["state", `${d.readyState ?? "—"} (target: ${d.target ?? "preview"})`],
                ["commit", d.commitSha ? `${d.commitSha.slice(0, 12)}…` : "—"],
                ["branch", d.commitRef ?? "—"],
                ["project", d.name ?? d.projectId ?? "—"],
                ["created", when(d.createdAt ? new Date(d.createdAt).toISOString() : null)],
                ["url", d.url ?? "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-4 py-1">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="font-mono text-xs text-slate-200">
                    {k === "commit" && commitUrl ? <a href={commitUrl} target="_blank" rel="noreferrer" className="text-lime hover:underline">{v}</a> : v}
                    {k === "url" && d.url ? <> <a href={`https://${d.url}`} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">open ↗</a></> : null}
                    {k === "url" && d.inspectorUrl ? <> <a href={d.inspectorUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">inspector ↗</a></> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {/* Linked request */}
        {req && (
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Linked approval request</h2>
            <dl className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
              {[
                ["id", req.id],
                ["action", req.action],
                ["target env", req.target_env],
                ["status", req.status],
                ["requested by", req.requested_by.slice(0, 8) + "…"],
                ["created", when(req.created_at)],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-4 py-1">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="font-mono text-xs text-slate-200">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-slate-500">
              Decisions and execution live on{" "}
              <Link href="/system/app/deployments" className="text-lime hover:underline">App → Deployments</Link>.
              {typeof (req.result as Record<string, unknown> | null)?.provider_deployment_id === "string" && (
                <> Provider deployment: <span className="font-mono">{String((req.result as Record<string, unknown>).provider_deployment_id).slice(0, 12)}…</span></>
              )}
            </p>
          </section>
        )}

        {/* Live status poll — 15s interval, stops on terminal provider state */}
        <DeploymentMonitor id={id} initialHealth={initialHealth} />

        {/* Build events / logs — only when a provider deployment exists */}
        {(d || detail.eventsStatus !== "unavailable") && (
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <h2 className="eyebrow text-slate-400">Build events</h2>
          {detail.eventsStatus === "requires_credentials" ? (
            <div className="mt-3 space-y-2 text-sm text-slate-400">
              <p><span className="font-mono text-amber-300">requires_credentials</span> — build logs are only available through the Vercel API.</p>
              <p className="font-mono text-[11px] text-slate-500">missing: {vg.missing.join(", ") || "VERCEL_TOKEN, VERCEL_PROJECT_ID"}</p>
            </div>
          ) : detail.eventsStatus === "error" ? (
            <p className="mt-3 font-mono text-xs text-red-300">events lookup failed: {detail.eventsError}</p>
          ) : detail.events && detail.events.length > 0 ? (
            <ul className="mt-3 max-h-[480px] space-y-1 overflow-y-auto font-mono text-[11px]">
              {detail.events.map((e, i) => (
                <li key={i} className="flex gap-3 border-b border-white/5 py-1.5 last:border-0">
                  <span className="shrink-0 text-slate-600">{e.createdAt ? new Date(e.createdAt).toISOString().slice(11, 19) : "--:--:--"}</span>
                  <span className="shrink-0 text-sky-300/80">{e.type ?? "event"}</span>
                  <span className="min-w-0 flex-1 break-words text-slate-300">{e.text ?? ""}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-400">No build events returned.</p>
          )}
        </section>
        )}

        {/* Manual instructions when provider can't execute */}
        {!vg.configured && req && (
          <section className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-5">
            <h2 className="eyebrow text-amber-300">Manual deploy path</h2>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-slate-300">
              {manualDeployInstructions(req.action, req.target_env).map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </section>
        )}
      </div>
    </SystemGate>
  );
}
