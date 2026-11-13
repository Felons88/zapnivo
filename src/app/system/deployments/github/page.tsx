export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import {
  githubGate, getGithubRepo, listGithubBranches, listGithubCommits,
  listGithubPullRequests, listGithubCheckRuns,
} from "@/lib/system/deploy-provider";

export const metadata: Metadata = { title: "GitHub — Deployment Center" };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default async function GithubDeploymentsPage() {
  const gate = githubGate();

  let repo = null as Awaited<ReturnType<typeof getGithubRepo>> | null;
  let branches = null as Awaited<ReturnType<typeof listGithubBranches>> | null;
  let commits = null as Awaited<ReturnType<typeof listGithubCommits>> | null;
  let prs = null as Awaited<ReturnType<typeof listGithubPullRequests>> | null;
  let checks = null as Awaited<ReturnType<typeof listGithubCheckRuns>> | null;

  if (gate.configured) {
    [repo, branches, commits, prs] = await Promise.all([
      getGithubRepo(), listGithubBranches(50), listGithubCommits(undefined, 20), listGithubPullRequests("open", 20),
    ]);
    const defaultRef = repo.configured && repo.ok ? repo.data.defaultBranch : "main";
    checks = await listGithubCheckRuns(defaultRef ?? "main");
  }

  return (
    <SystemGate perm="system.deployments.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Deployment Center</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">GitHub</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Source-control view for deploys — repo, branches, commits, pull requests and check runs.
              Read-only; the API token is server-only and never rendered.
            </p>
          </div>
          <Link href="/system/deployments" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
            ← Deployments
          </Link>
        </div>

        {!gate.configured ? (
          <Card title="GitHub provider — requires_credentials">
            <div className="space-y-2 text-sm text-slate-400">
              <p>The GitHub API is not configured. Set these env vars (server-only, never NEXT_PUBLIC_) and redeploy:</p>
              <ul className="space-y-1 font-mono text-xs text-slate-300">
                <li>· GITHUB_TOKEN — fine-grained PAT or classic token with repo read + checks read</li>
                <li>· GITHUB_REPO=owner/name — e.g. zapnivo/zapnivo-website</li>
                <li>· GITHUB_DEPLOY_REFS — optional, comma-separated refs allowed for API deploys (default: main)</li>
              </ul>
              <p className="text-xs text-slate-500">missing: {gate.missing.join(", ")}</p>
            </div>
          </Card>
        ) : (
          <>
            {/* Repo */}
            <Card title="Repository">
              {repo?.configured && repo.ok ? (
                <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
                  {[
                    ["repo", repo.data.fullName ?? "—"],
                    ["default branch", repo.data.defaultBranch ?? "—"],
                    ["visibility", repo.data.private === null ? "—" : repo.data.private ? "private" : "public"],
                    ["repo id", repo.data.id === null ? "—" : String(repo.data.id)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-4 py-1">
                      <dt className="text-slate-500">{k}</dt>
                      <dd className="font-mono text-xs text-slate-200">{v}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="font-mono text-xs text-red-300">repo lookup failed{repo?.configured && !repo.ok ? `: ${repo.error}` : ""}</p>
              )}
            </Card>

            {/* Branches */}
            <Card title={`Branches${branches?.configured && branches.ok ? ` (${branches.data.length})` : ""}`}>
              {branches?.configured && branches.ok ? (
                branches.data.length === 0 ? <p className="text-sm text-slate-400">No branches returned.</p> : (
                  <div className="flex flex-wrap gap-2">
                    {branches.data.map((b) => (
                      <span key={b.name} className="rounded-full bg-white/[0.06] px-3 py-1 font-mono text-[11px] text-slate-300 ring-1 ring-white/10">
                        {b.name}{b.protected ? " 🔒" : ""}
                      </span>
                    ))}
                  </div>
                )
              ) : (
                <p className="font-mono text-xs text-red-300">branch lookup failed{branches?.configured && !branches.ok ? `: ${branches.error}` : ""}</p>
              )}
            </Card>

            {/* Commits */}
            <Card title="Recent commits (default branch)">
              {commits?.configured && commits.ok ? (
                commits.data.length === 0 ? <p className="text-sm text-slate-400">No commits returned.</p> : (
                  <ul className="divide-y divide-white/5">
                    {commits.data.map((c) => (
                      <li key={c.sha} className="flex items-center gap-3 py-2 text-xs">
                        {c.htmlUrl ? (
                          <a href={c.htmlUrl} target="_blank" rel="noreferrer" className="font-mono text-lime hover:underline">{c.sha.slice(0, 7)}</a>
                        ) : <span className="font-mono text-slate-400">{c.sha.slice(0, 7)}</span>}
                        <span className="min-w-0 flex-1 truncate text-slate-300">{c.message ?? "—"}</span>
                        <span className="font-mono text-[10px] text-slate-500">{c.author ?? ""} · {when(c.date)}</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="font-mono text-xs text-red-300">commit lookup failed{commits?.configured && !commits.ok ? `: ${commits.error}` : ""}</p>
              )}
            </Card>

            {/* PRs */}
            <Card title="Open pull requests">
              {prs?.configured && prs.ok ? (
                prs.data.length === 0 ? <p className="text-sm text-slate-400">No open pull requests.</p> : (
                  <ul className="divide-y divide-white/5">
                    {prs.data.map((p) => (
                      <li key={p.number} className="flex items-center gap-3 py-2 text-xs">
                        {p.htmlUrl ? (
                          <a href={p.htmlUrl} target="_blank" rel="noreferrer" className="font-mono text-lime hover:underline">#{p.number}</a>
                        ) : <span className="font-mono text-slate-400">#{p.number}</span>}
                        <span className="min-w-0 flex-1 truncate text-slate-300">{p.title ?? "—"}{p.draft ? " (draft)" : ""}</span>
                        <span className="font-mono text-[10px] text-slate-500">{p.headRef} → {p.baseRef} · {p.author ?? ""} · {when(p.updatedAt)}</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="font-mono text-xs text-red-300">PR lookup failed{prs?.configured && !prs.ok ? `: ${prs.error}` : ""}</p>
              )}
            </Card>

            {/* Check runs */}
            <Card title={`Check runs — ${repo?.configured && repo.ok ? repo.data.defaultBranch ?? "main" : "main"}`}>
              {checks?.configured && checks.ok ? (
                checks.data.length === 0 ? <p className="text-sm text-slate-400">No check runs on this ref.</p> : (
                  <ul className="space-y-1">
                    {checks.data.map((c, i) => (
                      <li key={i} className="flex items-center gap-3 text-xs">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${
                          c.conclusion === "success" ? "bg-lime/15 text-lime ring-lime/30"
                          : c.conclusion === "failure" || c.conclusion === "cancelled" || c.conclusion === "timed_out" ? "bg-red-500/15 text-red-300 ring-red-400/30"
                          : "bg-amber-400/15 text-amber-300 ring-amber-400/30"
                        }`}>{c.conclusion ?? c.status ?? "unknown"}</span>
                        {c.htmlUrl ? (
                          <a href={c.htmlUrl} target="_blank" rel="noreferrer" className="text-slate-300 hover:text-lime hover:underline">{c.name ?? "check"}</a>
                        ) : <span className="text-slate-300">{c.name ?? "check"}</span>}
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="font-mono text-xs text-red-300">check-run lookup failed{checks?.configured && !checks.ok ? `: ${checks.error}` : ""}</p>
              )}
            </Card>
          </>
        )}
      </div>
    </SystemGate>
  );
}
