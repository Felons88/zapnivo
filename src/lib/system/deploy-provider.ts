import { scrub } from "@/lib/observability";

/**
 * Deployment-center provider clients (GitHub + Vercel REST APIs).
 *
 * Server-only by convention: tokens come from non-public env vars and are
 * NEVER returned, logged, or written to audit detail. Every function is
 * env-gated — with no token configured it returns { configured: false } and
 * performs ZERO network calls. All requests are bounded (8s timeout, 512KB
 * body cap) and errors are sanitized (token values stripped, message capped).
 *
 * Env contract:
 *  - VERCEL_TOKEN, VERCEL_PROJECT_ID  (VERCEL_TEAM_ID optional)
 *  - VERCEL_PROJECT_NAME optional (project display name for create calls)
 *  - VERCEL_GIT_REPO_ID optional (Vercel git repo id; falls back to GitHub repo id)
 *  - GITHUB_TOKEN, GITHUB_REPO="owner/name"
 *  - GITHUB_DEPLOY_REFS="main,release/*" — refs allowed for API-triggered deploys
 *    (default: "main" only)
 */

const VERCEL_API = "https://api.vercel.com";
const GITHUB_API = "https://api.github.com";
const UA = "zapnivo-system-console";
const TIMEOUT_MS = 8_000;
const MAX_BODY_CHARS = 512 * 1024;

/* ── Shared fetch plumbing ─────────────────────────────────────────────── */

export type ApiResult<T> =
  | { configured: true; ok: true; data: T; status: number }
  | { configured: true; ok: false; status: number; error: string }
  | { configured: false };

const NOT_CONFIGURED = { configured: false } as const;

/** Removes any occurrence of known secret env values, then truncates. */
function sanitizeError(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err ?? "unknown error");
  for (const name of ["VERCEL_TOKEN", "GITHUB_TOKEN", "VERCEL_TEAM_ID"]) {
    const v = process.env[name];
    if (v && v.length >= 6) msg = msg.split(v).join("[redacted]");
  }
  return scrub(msg, 240);
}

async function apiFetch<T>(
  url: string,
  init: { token: string; method?: string; body?: unknown; extraHeaders?: Record<string, string> },
): Promise<{ ok: true; status: number; json: T | null } | { ok: false; status: number; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${init.token}`,
        Accept: "application/json",
        "User-Agent": UA,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.extraHeaders,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, error: sanitizeError(e) };
  }
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, status: res.status, error: sanitizeError(e) };
  }
  if (text.length > MAX_BODY_CHARS) {
    return { ok: false, status: res.status, error: "provider response exceeded size cap" };
  }
  let json: T | null = null;
  if (text) {
    try { json = JSON.parse(text) as T; } catch { json = null; }
  }
  if (!res.ok) {
    // Provider error bodies may echo request details — sanitize + cap.
    const detail =
      json && typeof json === "object"
        ? (() => {
            const j = json as Record<string, unknown>;
            const err = j.error;
            if (err && typeof err === "object") {
              const eo = err as Record<string, unknown>;
              return String(eo.message ?? eo.code ?? "").slice(0, 200);
            }
            if (typeof j.message === "string") return j.message.slice(0, 200);
            return "";
          })()
        : "";
    return { ok: false, status: res.status, error: `provider HTTP ${res.status}${detail ? `: ${sanitizeError(detail)}` : ""}` };
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

/* ── Env gates ─────────────────────────────────────────────────────────── */

export type ProviderGate = { configured: boolean; missing: string[] };

export function vercelGate(): ProviderGate {
  const missing = [
    ...(!process.env.VERCEL_TOKEN ? ["VERCEL_TOKEN"] : []),
    ...(!process.env.VERCEL_PROJECT_ID ? ["VERCEL_PROJECT_ID"] : []),
  ];
  return { configured: missing.length === 0, missing };
}

export function githubGate(): ProviderGate {
  const missing = [
    ...(!process.env.GITHUB_TOKEN ? ["GITHUB_TOKEN"] : []),
    ...(!parseGithubRepo() ? ["GITHUB_REPO"] : []),
  ];
  return { configured: missing.length === 0, missing };
}

export const vercelConfigured = () => vercelGate().configured;
export const githubConfigured = () => githubGate().configured;

function vercelCreds(): { token: string; projectId: string; teamId?: string } | null {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) return null;
  return { token, projectId, teamId: process.env.VERCEL_TEAM_ID || undefined };
}

function githubCreds(): { token: string; owner: string; repo: string } | null {
  const token = process.env.GITHUB_TOKEN;
  const parsed = parseGithubRepo();
  if (!token || !parsed) return null;
  return { token, ...parsed };
}

export function parseGithubRepo(): { owner: string; repo: string } | null {
  const raw = (process.env.GITHUB_REPO ?? "").trim();
  const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(raw);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Git refs the deploy API will accept. Default is main only; operators can
 * widen via GITHUB_DEPLOY_REFS="main,release/*". Anything else is refused
 * before any provider call is made.
 */
export function allowedDeployRefs(): string[] {
  const raw = (process.env.GITHUB_DEPLOY_REFS ?? "").trim();
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["main"];
  return [...new Set(list)].slice(0, 20);
}

export function isAllowedDeployRef(ref: string): boolean {
  const r = ref.trim();
  if (!/^[A-Za-z0-9_./-]{1,200}$/.test(r) || r.includes("..")) return false;
  return allowedDeployRefs().some((allowed) =>
    allowed.endsWith("*") ? r.startsWith(allowed.slice(0, -1)) : r === allowed,
  );
}

/* ── Vercel API ────────────────────────────────────────────────────────── */

export type VercelDeployment = {
  uid: string;
  url: string | null;
  name: string | null;
  readyState: string | null;
  target: string | null;
  createdAt: number | null;
  readyAt: number | null;
  commitSha: string | null;
  commitRef: string | null;
  inspectorUrl: string | null;
  projectId: string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, 500) : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Normalizes a raw Vercel deployment object (v6 list item or v13 detail). */
export function normalizeVercelDeployment(raw: unknown): VercelDeployment | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const meta = (d.meta && typeof d.meta === "object" ? d.meta : {}) as Record<string, unknown>;
  const uid = str(d.uid) ?? str(d.id);
  if (!uid) return null;
  const url = str(d.url);
  return {
    uid,
    // Only ever surface *.vercel.app URLs — anything else is dropped, not linked.
    url: url && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(url) ? url : null,
    name: str(d.name),
    readyState: str(d.readyState) ?? str(d.state),
    target: str(d.target),
    createdAt: num(d.createdAt) ?? num(d.created),
    readyAt: num(d.ready),
    commitSha: str(meta.githubCommitSha) ?? str(meta.gitCommitSha),
    commitRef: str(meta.githubCommitRef) ?? str(meta.gitCommitRef),
    inspectorUrl: str(d.inspectorUrl),
    projectId: str(d.projectId),
  };
}

export async function listVercelDeployments(limit = 20): Promise<ApiResult<VercelDeployment[]>> {
  const c = vercelCreds();
  if (!c) return NOT_CONFIGURED;
  const r = await apiFetch<{ deployments?: unknown[] }>(
    `${VERCEL_API}/v6/deployments${qs({ projectId: c.projectId, teamId: c.teamId, limit })}`,
    { token: c.token },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  const list = Array.isArray(r.json?.deployments) ? r.json.deployments : [];
  return {
    configured: true, ok: true, status: r.status,
    data: list.map(normalizeVercelDeployment).filter((d): d is VercelDeployment => d !== null).slice(0, limit),
  };
}

export async function getVercelDeployment(uid: string): Promise<ApiResult<VercelDeployment>> {
  const c = vercelCreds();
  if (!c) return NOT_CONFIGURED;
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(uid)) {
    return { configured: true, ok: false, status: 400, error: "invalid deployment id" };
  }
  const r = await apiFetch<unknown>(
    `${VERCEL_API}/v13/deployments/${encodeURIComponent(uid)}${qs({ teamId: c.teamId })}`,
    { token: c.token },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  const d = normalizeVercelDeployment(r.json);
  if (!d) return { configured: true, ok: false, status: 502, error: "provider returned an unparseable deployment" };
  return { configured: true, ok: true, status: r.status, data: d };
}

export type VercelDeploymentEvent = { type: string | null; text: string | null; createdAt: number | null };

/** Build/deploy event log — GET /v3/deployments/{id}/events (bounded). */
export async function getVercelDeploymentEvents(uid: string, limit = 100): Promise<ApiResult<VercelDeploymentEvent[]>> {
  const c = vercelCreds();
  if (!c) return NOT_CONFIGURED;
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(uid)) {
    return { configured: true, ok: false, status: 400, error: "invalid deployment id" };
  }
  const r = await apiFetch<unknown>(
    `${VERCEL_API}/v3/deployments/${encodeURIComponent(uid)}/events${qs({ teamId: c.teamId, limit: Math.min(limit, 200), direction: "backward", builds: 0 })}`,
    { token: c.token },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  const raw = Array.isArray(r.json) ? r.json : [];
  const events: VercelDeploymentEvent[] = raw.slice(0, 200).map((e) => {
    const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    return {
      type: str(o.type),
      text: typeof o.text === "string" ? o.text.slice(0, 2000) : typeof o.payload === "string" ? o.payload.slice(0, 2000) : null,
      createdAt: num(o.created) ?? num(o.createdAt),
    };
  });
  return { configured: true, ok: true, status: r.status, data: events };
}

export type CreateDeploymentInput = { ref: string; target: "production" | "preview" };
export type CreateDeploymentResult =
  | { ok: true; deploymentId: string; url: string | null }
  | { ok: false; reason: string; status?: number };

/**
 * Creates a deployment from an approved git ref. Requires a resolvable Vercel
 * git repo id (VERCEL_GIT_REPO_ID, or the GitHub repo id when GITHUB_* is
 * configured). Ref validation happens in deploy-center BEFORE this is called.
 */
export async function createVercelDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult | { configured: false }> {
  const c = vercelCreds();
  if (!c) return { configured: false };

  let repoId = process.env.VERCEL_GIT_REPO_ID?.trim() || null;
  if (!repoId && githubConfigured()) {
    const repo = await getGithubRepo();
    if (repo.configured && repo.ok && typeof repo.data.id === "number") repoId = String(repo.data.id);
  }
  if (!repoId) {
    return { ok: false, reason: "git repo id unknown — set VERCEL_GIT_REPO_ID or configure GITHUB_TOKEN+GITHUB_REPO so the repo id can be resolved" };
  }

  const body: Record<string, unknown> = {
    project: c.projectId,
    gitSource: { type: "github", repoId, ref: input.ref },
  };
  const projectName = process.env.VERCEL_PROJECT_NAME?.trim();
  if (projectName) body.name = projectName;
  // 'production' targets the production environment; preview omits target so
  // Vercel builds a non-aliased preview deployment.
  if (input.target === "production") body.target = "production";

  const r = await apiFetch<{ id?: string; uid?: string; url?: string }>(
    `${VERCEL_API}/v13/deployments${qs({ teamId: c.teamId, forceNew: 1 })}`,
    { token: c.token, method: "POST", body },
  );
  if (!r.ok) return { ok: false, reason: r.error, status: r.status };
  const id = str(r.json?.id) ?? str(r.json?.uid);
  if (!id) return { ok: false, reason: "provider accepted the request but returned no deployment id" };
  const url = str(r.json?.url);
  return { ok: true, deploymentId: id, url: url && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(url) ? url : null };
}

/** Cancels a queued/building deployment. */
export async function cancelVercelDeployment(uid: string): Promise<ApiResult<{ cancelled?: boolean }>> {
  const c = vercelCreds();
  if (!c) return NOT_CONFIGURED;
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(uid)) {
    return { configured: true, ok: false, status: 400, error: "invalid deployment id" };
  }
  const r = await apiFetch<unknown>(
    `${VERCEL_API}/v12/deployments/${encodeURIComponent(uid)}/cancel${qs({ teamId: c.teamId })}`,
    { token: c.token, method: "PATCH" },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  return { configured: true, ok: true, status: r.status, data: { cancelled: true } };
}

/**
 * Instant rollback = promote a previous READY deployment back onto the
 * production aliases (POST /v10/projects/{id}/promote/{deploymentId}).
 */
export async function promoteVercelDeployment(uid: string): Promise<ApiResult<{ promoted?: boolean }>> {
  const c = vercelCreds();
  if (!c) return NOT_CONFIGURED;
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(uid)) {
    return { configured: true, ok: false, status: 400, error: "invalid deployment id" };
  }
  const r = await apiFetch<unknown>(
    `${VERCEL_API}/v10/projects/${encodeURIComponent(c.projectId)}/promote/${encodeURIComponent(uid)}${qs({ teamId: c.teamId })}`,
    { token: c.token, method: "POST" },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  return { configured: true, ok: true, status: r.status, data: { promoted: true } };
}

/* ── GitHub API ────────────────────────────────────────────────────────── */

const GH_HEADERS = { "X-GitHub-Api-Version": "2022-11-28" };
const ghUrl = (path: string) => `${GITHUB_API}${path}`;

export type GithubRepo = {
  id: number | null;
  fullName: string | null;
  defaultBranch: string | null;
  private: boolean | null;
  htmlUrl: string | null;
};

export async function getGithubRepo(): Promise<ApiResult<GithubRepo>> {
  const c = githubCreds();
  if (!c) return NOT_CONFIGURED;
  const r = await apiFetch<Record<string, unknown>>(
    ghUrl(`/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`),
    { token: c.token, extraHeaders: GH_HEADERS },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  const j = r.json ?? {};
  return {
    configured: true, ok: true, status: r.status,
    data: {
      id: typeof j.id === "number" ? j.id : null,
      fullName: str(j.full_name),
      defaultBranch: str(j.default_branch),
      private: typeof j.private === "boolean" ? j.private : null,
      htmlUrl: str(j.html_url),
    },
  };
}

export type GithubCommit = {
  sha: string;
  message: string | null;
  author: string | null;
  date: string | null;
  htmlUrl: string | null;
};

export async function listGithubCommits(ref?: string, perPage = 20): Promise<ApiResult<GithubCommit[]>> {
  const c = githubCreds();
  if (!c) return NOT_CONFIGURED;
  const path = ref
    ? `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/commits/${encodeURIComponent(ref)}`
    : `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/commits`;
  const r = await apiFetch<unknown[]>(
    ghUrl(`${path}${qs({ per_page: Math.min(perPage, 50) })}`),
    { token: c.token, extraHeaders: GH_HEADERS },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  const raw = Array.isArray(r.json) ? r.json : ref && r.json && typeof r.json === "object" ? [r.json] : [];
  const commits = raw.slice(0, 50).map((item): GithubCommit | null => {
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
  }).filter((x): x is GithubCommit => x !== null);
  return { configured: true, ok: true, status: r.status, data: commits };
}

export type GithubBranch = { name: string; sha: string | null; protected: boolean | null };

export async function listGithubBranches(perPage = 50): Promise<ApiResult<GithubBranch[]>> {
  const c = githubCreds();
  if (!c) return NOT_CONFIGURED;
  const r = await apiFetch<unknown[]>(
    ghUrl(`/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/branches${qs({ per_page: Math.min(perPage, 100) })}`),
    { token: c.token, extraHeaders: GH_HEADERS },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  const branches = (Array.isArray(r.json) ? r.json : []).slice(0, 100).map((item): GithubBranch | null => {
    const j = item as Record<string, unknown>;
    const name = str(j.name);
    if (!name) return null;
    const commit = (j.commit && typeof j.commit === "object" ? j.commit : {}) as Record<string, unknown>;
    return { name, sha: str(commit.sha), protected: typeof j.protected === "boolean" ? j.protected : null };
  }).filter((x): x is GithubBranch => x !== null);
  return { configured: true, ok: true, status: r.status, data: branches };
}

export type GithubPullRequest = {
  number: number;
  title: string | null;
  state: string | null;
  draft: boolean | null;
  author: string | null;
  headRef: string | null;
  baseRef: string | null;
  htmlUrl: string | null;
  updatedAt: string | null;
};

export async function listGithubPullRequests(state: "open" | "closed" | "all" = "open", perPage = 20): Promise<ApiResult<GithubPullRequest[]>> {
  const c = githubCreds();
  if (!c) return NOT_CONFIGURED;
  const r = await apiFetch<unknown[]>(
    ghUrl(`/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/pulls${qs({ state, per_page: Math.min(perPage, 50), sort: "updated", direction: "desc" })}`),
    { token: c.token, extraHeaders: GH_HEADERS },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  const prs = (Array.isArray(r.json) ? r.json : []).slice(0, 50).map((item): GithubPullRequest | null => {
    const j = item as Record<string, unknown>;
    if (typeof j.number !== "number") return null;
    const head = (j.head && typeof j.head === "object" ? j.head : {}) as Record<string, unknown>;
    const base = (j.base && typeof j.base === "object" ? j.base : {}) as Record<string, unknown>;
    const user = (j.user && typeof j.user === "object" ? j.user : {}) as Record<string, unknown>;
    return {
      number: j.number,
      title: str(j.title),
      state: str(j.state),
      draft: typeof j.draft === "boolean" ? j.draft : null,
      author: str(user.login),
      headRef: str(head.ref),
      baseRef: str(base.ref),
      htmlUrl: str(j.html_url),
      updatedAt: str(j.updated_at),
    };
  }).filter((x): x is GithubPullRequest => x !== null);
  return { configured: true, ok: true, status: r.status, data: prs };
}

export type GithubCheckRun = {
  name: string | null;
  status: string | null;
  conclusion: string | null;
  htmlUrl: string | null;
};

/** Check runs for a commit/branch ref (CI status). */
export async function listGithubCheckRuns(ref: string): Promise<ApiResult<GithubCheckRun[]>> {
  const c = githubCreds();
  if (!c) return NOT_CONFIGURED;
  if (!/^[A-Za-z0-9_./-]{1,200}$/.test(ref) || ref.includes("..")) {
    return { configured: true, ok: false, status: 400, error: "invalid ref" };
  }
  const r = await apiFetch<{ check_runs?: unknown[] }>(
    ghUrl(`/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/commits/${encodeURIComponent(ref)}/check-runs${qs({ per_page: 50 })}`),
    { token: c.token, extraHeaders: GH_HEADERS },
  );
  if (!r.ok) return { configured: true, ok: false, status: r.status, error: r.error };
  const runs = (Array.isArray(r.json?.check_runs) ? r.json.check_runs : []).slice(0, 50).map((item): GithubCheckRun | null => {
    const j = item as Record<string, unknown>;
    return {
      name: str(j.name),
      status: str(j.status),
      conclusion: str(j.conclusion),
      htmlUrl: str(j.html_url),
    };
  }).filter((x): x is GithubCheckRun => x !== null);
  return { configured: true, ok: true, status: r.status, data: runs };
}
