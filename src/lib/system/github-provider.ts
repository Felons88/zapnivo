import { scrub } from "@/lib/observability";
import { githubGate, parseGithubRepo } from "./deploy-provider";

/**
 * GitHub READ-ONLY provider client for the Deployment Center.
 *
 * Separate from deploy-provider.ts (which owns deploy-trigger plumbing) — this
 * module is a pure read surface: repo identity, branches, commits, open PRs,
 * CI check runs and release tags. NO write operations exist here by design.
 *
 * Server-only by convention: GITHUB_TOKEN comes from a non-public env var and
 * is NEVER returned, logged, or written to audit detail. With no env config
 * every function returns { configured: false } and performs ZERO network
 * calls. All requests are bounded (10s timeout, 512KB body cap) and errors
 * are sanitized machine codes — token values and raw provider bodies never
 * appear in results.
 *
 * Env contract (shared with deploy-provider.ts):
 *  - GITHUB_TOKEN — fine-grained PAT (Contents:read, Pull requests:read,
 *    Checks:read, Metadata:read) or GitHub App installation token
 *  - GITHUB_REPO="owner/name"
 */

const GITHUB_API = "https://api.github.com";
const UA = "zapnivo-system-console";
const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 512 * 1024;
const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": UA,
};

/* ── Result type ───────────────────────────────────────────────────────── */

export type GithubResult<T> =
  | { configured: false }
  | { configured: true; ok: true; data: T }
  | { configured: true; ok: false; reason: string; status?: number; detail?: string };

const NOT_CONFIGURED = { configured: false } as const;

/* ── Sanitization ──────────────────────────────────────────────────────── */

/** Removes any occurrence of the GitHub token, then truncates. */
function sanitizeError(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err ?? "unknown error");
  const token = process.env.GITHUB_TOKEN;
  if (token && token.length >= 6) msg = msg.split(token).join("[redacted]");
  return scrub(msg, 240);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, 500) : null;
}
/* ── Fetch plumbing ────────────────────────────────────────────────────── */

type GhFetchOk = { ok: true; status: number; json: unknown };
type GhFetchErr = { ok: false; reason: string; status?: number; detail?: string };

function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null;
}

function reasonFor(status: number, headers: Headers): string {
  if (isRateLimited(status, headers)) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 422) return "unprocessable";
  return "http_error";
}

/**
 * Bounded GET against api.github.com. Error results carry ONLY a machine
 * reason code + sanitized detail (provider `message` field capped at 200
 * chars, token stripped) — never the raw body.
 */
async function ghFetch(url: string, token: string): Promise<GhFetchOk | GhFetchErr> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, ...GH_HEADERS },
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, reason: "timeout", detail: "request exceeded 10s timeout" };
    }
    return { ok: false, reason: "network_error", detail: sanitizeError(e) };
  }

  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, reason: "read_error", status: res.status, detail: sanitizeError(e) };
  }
  if (text.length > MAX_BODY_CHARS) {
    return { ok: false, reason: "response_too_large", status: res.status };
  }

  let json: unknown = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }

  if (!res.ok) {
    // Provider error bodies may echo request details — extract only the
    // message field, sanitize, cap. Raw body is discarded.
    let detail: string | undefined;
    if (json && typeof json === "object") {
      const j = json as Record<string, unknown>;
      const errObj = j.error;
      const raw =
        errObj && typeof errObj === "object"
          ? String((errObj as Record<string, unknown>).message ?? "")
          : typeof j.message === "string"
            ? j.message
            : "";
      if (raw) detail = sanitizeError(raw.slice(0, 200));
    }
    return { ok: false, reason: reasonFor(res.status, res.headers), status: res.status, detail };
  }
  return { ok: true, status: res.status, json };
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

function repoPath(): string | null {
  const r = parseGithubRepo();
  return r ? `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}` : null;
}

function creds(): { token: string } | null {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !repoPath()) return null;
  return { token };
}

/** Ref/sha validation — same charset rule as deploy-provider. */
function validRef(ref: string): boolean {
  return /^[A-Za-z0-9_./-]{1,200}$/.test(ref) && !ref.includes("..");
}

/* ── Types ─────────────────────────────────────────────────────────────── */

export type GithubRepoInfo = {
  name: string | null;
  fullName: string | null;
  defaultBranch: string | null;
  /** "public" | "private" | "internal" (GitHub Enterprise). */
  visibility: string | null;
  htmlUrl: string | null;
  description: string | null;
};

export type GithubBranchInfo = {
  name: string;
  protected: boolean | null;
  commitSha: string | null;
  htmlUrl: string | null;
};

export type GithubCommitInfo = {
  sha: string;
  message: string | null;
  author: string | null;
  date: string | null;
  htmlUrl: string | null;
};

export type GithubPullRequestInfo = {
  number: number;
  title: string | null;
  author: string | null;
  headRef: string | null;
  baseRef: string | null;
  draft: boolean | null;
  /** From GET /pulls/{n} enrichment — null when not fetched or probe failed. */
  mergeable: boolean | null;
  mergeableState: string | null;
  htmlUrl: string | null;
  updatedAt: string | null;
};

export type GithubCheckRunInfo = {
  name: string | null;
  status: string | null;
  conclusion: string | null;
  htmlUrl: string | null;
};

export type GithubReleaseTag = {
  /** Release tag name (tag_name, falling back to name). */
  name: string;
  /** target_commitish — usually a sha, may be a branch for draft releases. */
  sha: string | null;
  htmlUrl: string | null;
  draft: boolean | null;
  prerelease: boolean | null;
  publishedAt: string | null;
};

/* ── Reads ─────────────────────────────────────────────────────────────── */

/** Repository identity — GET /repos/{owner}/{repo}. */
export async function getRepository(): Promise<GithubResult<GithubRepoInfo>> {
  const c = creds();
  const path = repoPath();
  if (!c || !path) return NOT_CONFIGURED;
  const r = await ghFetch(`${GITHUB_API}${path}`, c.token);
  if (!r.ok) return { configured: true, ok: false, reason: r.reason, status: r.status, detail: r.detail };
  const j = (r.json && typeof r.json === "object" ? r.json : {}) as Record<string, unknown>;
  const visibility =
    j.visibility === "public" || j.visibility === "private" || j.visibility === "internal"
      ? j.visibility
      : j.private === true ? "private" : j.private === false ? "public" : null;
  return {
    configured: true, ok: true,
    data: {
      name: str(j.name),
      fullName: str(j.full_name),
      defaultBranch: str(j.default_branch),
      visibility,
      htmlUrl: str(j.html_url),
      description: str(j.description),
    },
  };
}

/** Branches — GET /repos/{owner}/{repo}/branches. */
export async function listBranches(perPage = 100): Promise<GithubResult<GithubBranchInfo[]>> {
  const c = creds();
  const path = repoPath();
  if (!c || !path) return NOT_CONFIGURED;
  const parsed = parseGithubRepo();
  const repoUrl = parsed ? `https://github.com/${parsed.owner}/${parsed.repo}` : "";
  const r = await ghFetch(
    `${GITHUB_API}${path}/branches${qs({ per_page: Math.min(perPage, 100) })}`,
    c.token,
  );
  if (!r.ok) return { configured: true, ok: false, reason: r.reason, status: r.status, detail: r.detail };
  const branches = (Array.isArray(r.json) ? r.json : []).slice(0, 100).map((item): GithubBranchInfo | null => {
    const j = item as Record<string, unknown>;
    const name = str(j.name);
    if (!name) return null;
    const commit = (j.commit && typeof j.commit === "object" ? j.commit : {}) as Record<string, unknown>;
    return {
      name,
      protected: typeof j.protected === "boolean" ? j.protected : null,
      commitSha: str(commit.sha),
      // Branch list items carry no html_url — synthesize the canonical tree URL.
      htmlUrl: repoUrl ? `${repoUrl}/tree/${encodeURIComponent(name)}` : null,
    };
  }).filter((x): x is GithubBranchInfo => x !== null);
  return { configured: true, ok: true, data: branches };
}

/**
 * Recent commits on a branch (or the repo default branch when `branch` is
 * omitted) — GET /repos/{owner}/{repo}/commits?sha={branch}.
 */
export async function listCommits(branch?: string, perPage = 20): Promise<GithubResult<GithubCommitInfo[]>> {
  const c = creds();
  const path = repoPath();
  if (!c || !path) return NOT_CONFIGURED;
  if (branch !== undefined && !validRef(branch)) {
    return { configured: true, ok: false, reason: "invalid_ref", status: 400 };
  }
  const r = await ghFetch(
    `${GITHUB_API}${path}/commits${qs({ sha: branch, per_page: Math.min(perPage, 50) })}`,
    c.token,
  );
  if (!r.ok) return { configured: true, ok: false, reason: r.reason, status: r.status, detail: r.detail };
  const commits = (Array.isArray(r.json) ? r.json : []).slice(0, 50).map((item): GithubCommitInfo | null => {
    const j = item as Record<string, unknown>;
    const sha = str(j.sha);
    if (!sha) return null;
    const commit = (j.commit && typeof j.commit === "object" ? j.commit : {}) as Record<string, unknown>;
    const author = (commit.author && typeof commit.author === "object" ? commit.author : {}) as Record<string, unknown>;
    return {
      sha,
      message: typeof commit.message === "string" ? commit.message.split("\n")[0].slice(0, 300) : null,
      author: str(author.name),
      date: str(author.date),
      htmlUrl: str(j.html_url),
    };
  }).filter((x): x is GithubCommitInfo => x !== null);
  return { configured: true, ok: true, data: commits };
}

/**
 * Open pull requests — GET /repos/{owner}/{repo}/pulls?state=open.
 * `mergeable`/`mergeableState` are enriched via GET /pulls/{n} for the first
 * `enrichMergeable` PRs only (bounded extra reads; failures stay null).
 */
export async function listOpenPullRequests(
  perPage = 20,
  enrichMergeable = 5,
): Promise<GithubResult<GithubPullRequestInfo[]>> {
  const c = creds();
  const path = repoPath();
  if (!c || !path) return NOT_CONFIGURED;
  const r = await ghFetch(
    `${GITHUB_API}${path}/pulls${qs({ state: "open", per_page: Math.min(perPage, 50), sort: "updated", direction: "desc" })}`,
    c.token,
  );
  if (!r.ok) return { configured: true, ok: false, reason: r.reason, status: r.status, detail: r.detail };

  const prs = (Array.isArray(r.json) ? r.json : []).slice(0, 50).map((item): GithubPullRequestInfo | null => {
    const j = item as Record<string, unknown>;
    if (typeof j.number !== "number") return null;
    const head = (j.head && typeof j.head === "object" ? j.head : {}) as Record<string, unknown>;
    const base = (j.base && typeof j.base === "object" ? j.base : {}) as Record<string, unknown>;
    const user = (j.user && typeof j.user === "object" ? j.user : {}) as Record<string, unknown>;
    return {
      number: j.number,
      title: str(j.title),
      author: str(user.login),
      headRef: str(head.ref),
      baseRef: str(base.ref),
      draft: typeof j.draft === "boolean" ? j.draft : null,
      mergeable: null,
      mergeableState: null,
      htmlUrl: str(j.html_url),
      updatedAt: str(j.updated_at),
    };
  }).filter((x): x is GithubPullRequestInfo => x !== null);

  // Mergeable enrichment — one extra GET per PR, capped, failures tolerated.
  const enrichCount = Math.min(Math.max(0, enrichMergeable), prs.length, 10);
  if (enrichCount > 0) {
    const details = await Promise.all(
      prs.slice(0, enrichCount).map((p) => ghFetch(`${GITHUB_API}${path}/pulls/${p.number}`, c.token)),
    );
    details.forEach((d, i) => {
      if (!d.ok || !d.json || typeof d.json !== "object") return;
      const j = d.json as Record<string, unknown>;
      prs[i].mergeable = typeof j.mergeable === "boolean" ? j.mergeable : null;
      prs[i].mergeableState = str(j.mergeable_state);
    });
  }

  return { configured: true, ok: true, data: prs };
}

/**
 * CI check runs for a commit sha — GET /repos/{owner}/{repo}/commits/{sha}/check-runs.
 */
export async function getCheckRuns(sha: string, perPage = 50): Promise<GithubResult<GithubCheckRunInfo[]>> {
  const c = creds();
  const path = repoPath();
  if (!c || !path) return NOT_CONFIGURED;
  if (!validRef(sha)) {
    return { configured: true, ok: false, reason: "invalid_ref", status: 400 };
  }
  const r = await ghFetch(
    `${GITHUB_API}${path}/commits/${encodeURIComponent(sha)}/check-runs${qs({ per_page: Math.min(perPage, 100) })}`,
    c.token,
  );
  if (!r.ok) return { configured: true, ok: false, reason: r.reason, status: r.status, detail: r.detail };
  const runs = (Array.isArray((r.json as Record<string, unknown> | null)?.check_runs)
    ? ((r.json as Record<string, unknown>).check_runs as unknown[])
    : []
  ).slice(0, 100).map((item): GithubCheckRunInfo | null => {
    const j = item as Record<string, unknown>;
    return {
      name: str(j.name),
      status: str(j.status),
      conclusion: str(j.conclusion),
      htmlUrl: str(j.html_url),
    };
  }).filter((x): x is GithubCheckRunInfo => x !== null);
  return { configured: true, ok: true, data: runs };
}

/**
 * Release tags — GET /repos/{owner}/{repo}/releases (newest first).
 * `sha` is the release target_commitish (the commit the tag points at for
 * published releases; may be a branch name for drafts).
 */
export async function listReleaseTags(perPage = 20): Promise<GithubResult<GithubReleaseTag[]>> {
  const c = creds();
  const path = repoPath();
  if (!c || !path) return NOT_CONFIGURED;
  const r = await ghFetch(
    `${GITHUB_API}${path}/releases${qs({ per_page: Math.min(perPage, 50) })}`,
    c.token,
  );
  if (!r.ok) return { configured: true, ok: false, reason: r.reason, status: r.status, detail: r.detail };
  const tags = (Array.isArray(r.json) ? r.json : []).slice(0, 50).map((item): GithubReleaseTag | null => {
    const j = item as Record<string, unknown>;
    const name = str(j.tag_name) ?? str(j.name);
    if (!name) return null;
    return {
      name,
      sha: str(j.target_commitish),
      htmlUrl: str(j.html_url),
      draft: typeof j.draft === "boolean" ? j.draft : null,
      prerelease: typeof j.prerelease === "boolean" ? j.prerelease : null,
      publishedAt: str(j.published_at),
    };
  }).filter((x): x is GithubReleaseTag => x !== null);
  return { configured: true, ok: true, data: tags };
}

/* ── Status / overview ─────────────────────────────────────────────────── */

export type GithubGate = { configured: boolean; missing: string[] };

/** Env gate — no network calls. */
export function githubStatus(): GithubGate {
  return githubGate();
}

export type GithubOverview = {
  configured: boolean;
  missing: string[];
  repository: GithubResult<GithubRepoInfo>;
  branches: GithubResult<GithubBranchInfo[]>;
  commits: GithubResult<GithubCommitInfo[]>;
  pullRequests: GithubResult<GithubPullRequestInfo[]>;
  releaseTags: GithubResult<GithubReleaseTag[]>;
  checkRuns: GithubResult<GithubCheckRunInfo[]>;
};

/**
 * One-shot read fan-out for the overview API + page: repo identity first
 * (to resolve the default branch), then branches/commits/PRs/tags/check-runs
 * in parallel. Commits default to the repo's default branch; check runs target
 * that branch's head sha when resolvable, else the branch name itself.
 */
export async function githubOverview(): Promise<GithubOverview> {
  const gate = githubGate();
  const empty = {
    configured: false as const,
  };
  if (!gate.configured) {
    return {
      configured: false,
      missing: gate.missing,
      repository: empty, branches: empty, commits: empty,
      pullRequests: empty, releaseTags: empty, checkRuns: empty,
    };
  }

  const repository = await getRepository();
  const defaultBranch = repository.configured && repository.ok ? repository.data.defaultBranch ?? undefined : undefined;

  const [branches, commits, pullRequests, releaseTags] = await Promise.all([
    listBranches(100),
    listCommits(defaultBranch, 20),
    listOpenPullRequests(20, 5),
    listReleaseTags(20),
  ]);

  // Check runs target the default branch head — prefer the branch list's
  // recorded sha, fall back to the branch name (GitHub resolves refs).
  const headSha =
    branches.configured && branches.ok
      ? branches.data.find((b) => b.name === defaultBranch)?.commitSha ?? undefined
      : undefined;
  const checkRef = headSha ?? defaultBranch ?? "main";
  const checkRuns = await getCheckRuns(checkRef, 50);

  return {
    configured: true,
    missing: gate.missing,
    repository, branches, commits, pullRequests, releaseTags, checkRuns,
  };
}
