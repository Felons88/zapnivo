import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { systemAudit } from "@/lib/system/audit";
import { githubOverview } from "@/lib/system/github-provider";

/**
 * GET /api/system/deployments/github/overview — read-only GitHub overview:
 * repo identity, branches, recent commits, open PRs, release tags and CI
 * check runs. All data comes from api.github.com via the server-only
 * GITHUB_TOKEN; the token is never exposed. Requires system.deployments.view.
 * The read is audit-logged (metadata only — counts and configured flag).
 */
export async function GET() {
  const g = await systemApiGuard("system.deployments.view", { limit: 60 });
  if (!g.ok) return g.res;

  const overview = await githubOverview();

  const count = (r: { configured: boolean; ok?: boolean; data?: unknown[] }) =>
    r.configured && r.ok ? (Array.isArray(r.data) ? r.data.length : 1) : 0;

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "deployments.github_overview.viewed",
    resource: "github:repository",
    detail: {
      configured: overview.configured,
      branches: count(overview.branches),
      commits: count(overview.commits),
      pull_requests: count(overview.pullRequests),
      release_tags: count(overview.releaseTags),
      check_runs: count(overview.checkRuns),
    },
  });

  return NextResponse.json({ overview });
}
