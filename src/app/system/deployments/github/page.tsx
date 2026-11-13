export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { githubOverview, githubStatus, type GithubResult } from "@/lib/system/github-provider";

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

function Err({ r }: { r: GithubResult<unknown> }) {
  if (r.configured && !r.ok) {
    return <p className="font-mono text-xs text-red-300">{r.reason}{r.status ? ` (HTTP ${r.status})` : ""}{r.detail ? ` — ${r.detail}` : ""}</p>;
  }
  return <p className="text-sm text-slate-400">No data returned.</p>;
}

function ExtLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-lime hover:underline">
      {children}
    </a>
  );
}

export default async function GithubDeploymentsPage() {
  const gate = githubStatus();
  const overview = gate.configured ? await githubOverview() : null;

  const repo = overview?.repository ?? null;
  const defaultBranch = repo?.configured && repo.ok ? repo.data.defaultBranch : null;

  return (
    <SystemGate perm="system.deployments.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Deployment Center</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">GitHub</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Source-control view for deploys — repo, branches, commits, pull requests, check runs and
              release tags. Read-only; the API token is server-only and never rendered.
            </p>
          </div>
          <div className="flex gap-2">
            <a href="/api/system/deployments/github/overview" target="_blank" rel="noreferrer"
              className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
              JSON overview ↗
            </a>
            <Link href="/system/deployments" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
              ← Deployments
            </Link>
          </div>
        </div>

        {!gate.configured ? (
          <Card title="GitHub provider — requires_credentials">
            <div className="space-y-2 text-sm text-slate-400">
              <p>The GitHub API is not configured. Set these env vars (server-only, never NEXT_PUBLIC_) and redeploy:</p>
              <ul className="space-y-1 font-mono text-xs text-slate-300">
                <li>· GITHUB_TOKEN — fine-grained PAT with <span className="text-slate-200">Contents: read</span>, <span className="text-slate-200">Pull requests: read</span>, <span className="text-slate-200">Checks: read</span>, <span className="text-slate-200">Metadata: read</span> — or a GitHub App installation token</li>
                <li>· GITHUB_REPO=owner/name — e.g. zapnivo/zapnivo-website</li>
                <li>· GITHUB_DEPLOY_REFS — optional, comma-separated refs allowed for API deploys (default: main)</li>
              </ul>
              <p className="text-xs text-slate-500">missing: {gate.missing.join(", ")}</p>
            </div>
          </Card>
        ) : overview ? (
          <>
            {/* Repo identity */}
            <Card title="Repository">
              {repo?.configured && repo.ok ? (
                <div className="space-y-3">
                  <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
                    {[
                      ["repo", repo.data.fullName ?? "—"],
                      ["default branch", repo.data.defaultBranch ?? "—"],
                      ["visibility", repo.data.visibility ?? "—"],
                      ["description", repo.data.description ?? "—"],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-4 py-1">
                        <dt className="text-slate-500">{k}</dt>
                        <dd className="font-mono text-xs text-slate-200">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {repo.data.htmlUrl && (
                    <ExtLink href={repo.data.htmlUrl}>
                      <span className="font-mono text-xs">open on GitHub ↗</span>
                    </ExtLink>
                  )}
                </div>
              ) : repo ? (
                <Err r={repo} />
              ) : null}
            </Card>

            {/* Branches table */}
            <Card title={`Branches${overview.branches.configured && overview.branches.ok ? ` (${overview.branches.data.length})` : ""}`}>
              {overview.branches.configured && overview.branches.ok ? (
                overview.branches.data.length === 0 ? <p className="text-sm text-slate-400">No branches returned.</p> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                          <th className="py-2 pr-4 font-medium">branch</th>
                          <th className="py-2 pr-4 font-medium">head</th>
                          <th className="py-2 pr-4 font-medium">protected</th>
                          <th className="py-2 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {overview.branches.data.map((b) => (
                          <tr key={b.name} className="text-slate-300">
                            <td className="py-2 pr-4 font-mono text-slate-200">{b.name}</td>
                            <td className="py-2 pr-4 font-mono text-[10px] text-slate-500">{b.commitSha ? b.commitSha.slice(0, 7) : "—"}</td>
                            <td className="py-2 pr-4">{b.protected === null ? "—" : b.protected ? "🔒 yes" : "no"}</td>
                            <td className="py-2 text-right">
                              <ExtLink href={b.htmlUrl}><span className="font-mono text-[10px]">view ↗</span></ExtLink>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : overview.branches.configured ? (
                <Err r={overview.branches} />
              ) : null}
            </Card>

            {/* Recent commits */}
            <Card title={`Recent commits${defaultBranch ? ` — ${defaultBranch}` : ""}`}>
              {overview.commits.configured && overview.commits.ok ? (
                overview.commits.data.length === 0 ? <p className="text-sm text-slate-400">No commits returned.</p> : (
                  <ul className="divide-y divide-white/5">
                    {overview.commits.data.map((c) => (
                      <li key={c.sha} className="flex items-center gap-3 py-2 text-xs">
                        <ExtLink href={c.htmlUrl}>
                          <span className="font-mono text-lime">{c.sha.slice(0, 7)}</span>
                        </ExtLink>
                        <span className="min-w-0 flex-1 truncate text-slate-300">{c.message ?? "—"}</span>
                        <span className="font-mono text-[10px] text-slate-500">{c.author ?? ""} · {when(c.date)}</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : overview.commits.configured ? (
                <Err r={overview.commits} />
              ) : null}
            </Card>

            {/* Open PRs */}
            <Card title="Open pull requests">
              {overview.pullRequests.configured && overview.pullRequests.ok ? (
                overview.pullRequests.data.length === 0 ? <p className="text-sm text-slate-400">No open pull requests.</p> : (
                  <ul className="divide-y divide-white/5">
                    {overview.pullRequests.data.map((p) => (
                      <li key={p.number} className="flex items-center gap-3 py-2 text-xs">
                        <ExtLink href={p.htmlUrl}>
                          <span className="font-mono text-lime">#{p.number}</span>
                        </ExtLink>
                        <span className="min-w-0 flex-1 truncate text-slate-300">{p.title ?? "—"}{p.draft ? " (draft)" : ""}</span>
                        <span className="font-mono text-[10px] text-slate-500">
                          {p.headRef} → {p.baseRef} · {p.author ?? ""}
                          {p.mergeable !== null ? ` · ${p.mergeable ? "mergeable" : "conflicts"}` : ""}
                          {" · "}{when(p.updatedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              ) : overview.pullRequests.configured ? (
                <Err r={overview.pullRequests} />
              ) : null}
            </Card>

            {/* Check runs */}
            <Card title={`Check runs — ${defaultBranch ?? "default branch"}`}>
              {overview.checkRuns.configured && overview.checkRuns.ok ? (
                overview.checkRuns.data.length === 0 ? <p className="text-sm text-slate-400">No check runs on this ref.</p> : (
                  <ul className="space-y-1">
                    {overview.checkRuns.data.map((c, i) => (
                      <li key={i} className="flex items-center gap-3 text-xs">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${
                          c.conclusion === "success" ? "bg-lime/15 text-lime ring-lime/30"
                          : c.conclusion === "failure" || c.conclusion === "cancelled" || c.conclusion === "timed_out" ? "bg-red-500/15 text-red-300 ring-red-400/30"
                          : "bg-amber-400/15 text-amber-300 ring-amber-400/30"
                        }`}>{c.conclusion ?? c.status ?? "unknown"}</span>
                        <ExtLink href={c.htmlUrl}>
                          <span className="text-slate-300 hover:text-lime">{c.name ?? "check"}</span>
                        </ExtLink>
                      </li>
                    ))}
                  </ul>
                )
              ) : overview.checkRuns.configured ? (
                <Err r={overview.checkRuns} />
              ) : null}
            </Card>

            {/* Release tags */}
            <Card title="Release tags">
              {overview.releaseTags.configured && overview.releaseTags.ok ? (
                overview.releaseTags.data.length === 0 ? <p className="text-sm text-slate-400">No releases returned.</p> : (
                  <ul className="divide-y divide-white/5">
                    {overview.releaseTags.data.map((t) => (
                      <li key={t.name} className="flex items-center gap-3 py-2 text-xs">
                        <ExtLink href={t.htmlUrl}>
                          <span className="font-mono text-lime">{t.name}</span>
                        </ExtLink>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-500">
                          {t.sha ? t.sha.slice(0, 10) : "—"}
                        </span>
                        <span className="font-mono text-[10px] text-slate-500">
                          {t.draft ? "draft · " : ""}{t.prerelease ? "pre-release · " : ""}{when(t.publishedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              ) : overview.releaseTags.configured ? (
                <Err r={overview.releaseTags} />
              ) : null}
            </Card>
          </>
        ) : null}
      </div>
    </SystemGate>
  );
}
