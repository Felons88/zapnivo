import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import {
  allowedDeployRefs, githubConfigured, isAllowedDeployRef, listGithubCommits,
  listVercelDeployments, normalizeVercelDeployment, parseGithubRepo,
  promoteVercelDeployment, vercelConfigured,
} from "@/lib/system/deploy-provider";
import {
  executeDeploymentCenterRequest, githubCommitUrl, listDeployments,
  probeableUrl, requestDeploy, requestRollback, rollbackCandidates,
  vercelEnv, vercelState,
} from "@/lib/system/deploy-center";
import type { DeploymentRequestRow } from "@/lib/system/deployops";

/* ── Env + fetch fixtures ──────────────────────────────────────────────── */

const ENV_KEYS = [
  "VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID", "VERCEL_GIT_REPO_ID",
  "VERCEL_PROJECT_NAME", "GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_DEPLOY_REFS",
  "DEPLOY_PROBE_DOMAINS",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  vi.unstubAllGlobals();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

const setProviderEnv = () => {
  process.env.VERCEL_TOKEN = "vercel-secret-token-abc";
  process.env.VERCEL_PROJECT_ID = "prj_test123";
  process.env.VERCEL_GIT_REPO_ID = "987654";
  process.env.GITHUB_TOKEN = "ghp_testtoken456";
  process.env.GITHUB_REPO = "zapnivo/zapnivo-website";
  process.env.GITHUB_DEPLOY_REFS = "main,release/*";
};

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/* ── Minimal Supabase stub (same shape as system-deployops.test.ts) ────── */

type Result = { data?: unknown; error?: { message: string } | null };

function fakeTable(opts: { singles?: Result[]; select?: Result } = {}) {
  const singles = [...(opts.singles ?? [])];
  const calls = { inserted: [] as unknown[], updated: [] as unknown[], eqFilters: [] as unknown[][] };
  const b: Record<string, unknown> = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "filter"]) {
    b[m] = () => b;
  }
  b.eq = (...a: unknown[]) => { calls.eqFilters.push(a); return b; };
  b.limit = () => b;
  b.insert = (row: unknown) => { calls.inserted.push(row); return b; };
  b.update = (row: unknown) => { calls.updated.push(row); return b; };
  b.delete = () => b;
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(opts.select ?? { data: [], error: null }).then(res, rej);
  (b as { _calls?: typeof calls })._calls = calls;
  return b;
}

function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}
const callsOf = (t: ReturnType<typeof fakeTable>) => (t as unknown as { _calls: { inserted: unknown[]; updated: unknown[]; eqFilters: unknown[][] } })._calls;

const requester = { id: "req-1", role: "engineer" };
const executor = { id: "exe-3", role: "sysadmin" };
const sessionUser = (id: string): SessionUser => ({ id, email: `${id}@test`, role: "staff" as SessionUser["role"], organizationId: null });

const reqRow = (over: Partial<DeploymentRequestRow> = {}): DeploymentRequestRow => ({
  id: "d-1", action: "deploy", target_env: "production",
  justification: "ship v1.4.2", status: "approved",
  requested_by: "req-1", decided_by: "apr-2", decided_at: new Date().toISOString(),
  result: { ref: "main" }, created_at: new Date().toISOString(), ...over,
});

const liveElevation = {
  id: "elev-1", profile_id: "exe-3", method: "totp",
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  consumed_action: null, created_ip: null,
};

/* ── Provider gating ───────────────────────────────────────────────────── */

describe("provider gating", () => {
  it("returns configured:false and performs NO fetch without tokens", async () => {
    const fetchSpy = mockFetch(() => jsonRes({}));
    expect(vercelConfigured()).toBe(false);
    expect(githubConfigured()).toBe(false);
    const v = await listVercelDeployments();
    const g = await listGithubCommits();
    expect(v.configured).toBe(false);
    expect(g.configured).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses GITHUB_REPO strictly", () => {
    expect(parseGithubRepo()).toBeNull();
    process.env.GITHUB_REPO = "owner/repo";
    expect(parseGithubRepo()).toEqual({ owner: "owner", repo: "repo" });
    process.env.GITHUB_REPO = "bad format!!";
    expect(parseGithubRepo()).toBeNull();
  });

  it("validates deploy refs against the allowlist", () => {
    expect(isAllowedDeployRef("main")).toBe(true); // default allowlist
    expect(isAllowedDeployRef("feature/x")).toBe(false);
    setProviderEnv();
    expect(allowedDeployRefs()).toEqual(["main", "release/*"]);
    expect(isAllowedDeployRef("release/2025.1")).toBe(true);
    expect(isAllowedDeployRef("release")).toBe(false); // needs the slash suffix? 'release' doesn't match 'release/*'
    expect(isAllowedDeployRef("../etc")).toBe(false);
    expect(isAllowedDeployRef("main;rm -rf")).toBe(false);
  });
});

/* ── Vercel client ─────────────────────────────────────────────────────── */

describe("vercel client", () => {
  it("lists + normalizes deployments and maps states/envs", async () => {
    setProviderEnv();
    mockFetch((url) => {
      expect(url).toContain("api.vercel.com/v6/deployments");
      expect(url).toContain("projectId=prj_test123");
      return jsonRes({
        deployments: [
          { uid: "dpl_1", url: "app-git-main-zap.vercel.app", readyState: "READY", target: "production", createdAt: 1700000000000, meta: { githubCommitSha: "abc1234567890", githubCommitRef: "main" } },
          { uid: "dpl_2", url: "EVIL.example.com", readyState: "BUILDING", target: null, createdAt: 1700000001000, meta: {} },
        ],
      });
    });
    const res = await listVercelDeployments();
    expect(res.configured && res.ok).toBe(true);
    if (!(res.configured && res.ok)) return;
    expect(res.data).toHaveLength(2);
    expect(res.data[0].url).toBe("app-git-main-zap.vercel.app");
    // Non-vercel.app URL is dropped, never surfaced.
    expect(res.data[1].url).toBeNull();
    expect(vercelState(res.data[0].readyState, res.data[0].target)).toBe("ready");
    expect(vercelEnv(res.data[0].target, res.data[0].commitRef)).toBe("production");
    expect(vercelEnv(null, "feature")).toBe("preview");
  });

  it("creates a preview deployment via POST /v13 with gitSource ref", async () => {
    setProviderEnv();
    const fetchSpy = mockFetch((url, init) => {
      expect(url).toContain("/v13/deployments");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.gitSource).toEqual({ type: "github", repoId: "987654", ref: "release/2025.1" });
      expect(body.target).toBeUndefined(); // preview → no production target
      return jsonRes({ id: "dpl_new1", url: "app-git-release-zap.vercel.app" }, 200);
    });
    const { createVercelDeployment } = await import("@/lib/system/deploy-provider");
    const res = await createVercelDeployment({ ref: "release/2025.1", target: "preview" });
    expect("configured" in res && res.configured === false).toBe(false);
    if ("ok" in res && res.ok) {
      expect(res.deploymentId).toBe("dpl_new1");
      expect(res.url).toBe("app-git-release-zap.vercel.app");
    } else {
      expect.unreachable("should have succeeded");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("promote hits the project promote endpoint", async () => {
    setProviderEnv();
    mockFetch((url, init) => {
      expect(url).toContain("/v10/projects/prj_test123/promote/dpl_old1");
      expect(init?.method).toBe("POST");
      return jsonRes({});
    });
    const res = await promoteVercelDeployment("dpl_old1");
    expect(res.configured && res.ok).toBe(true);
  });

  it("sanitizes provider errors — token never leaks", async () => {
    setProviderEnv();
    mockFetch(() => {
      throw new Error(`connect failed with token vercel-secret-token-abc`);
    });
    const res = await listVercelDeployments();
    expect(res.configured && !res.ok).toBe(true);
    if (res.configured && !res.ok) {
      expect(res.error).not.toContain("vercel-secret-token-abc");
      expect(res.error).toContain("[redacted]");
    }
  });
});

/* ── URL probe allowlist ───────────────────────────────────────────────── */

describe("probeableUrl", () => {
  it("only allows https *.vercel.app and allowlisted domains", () => {
    expect(probeableUrl("https://app-git-main-zap.vercel.app")).toBe("https://app-git-main-zap.vercel.app/");
    expect(probeableUrl("https://evil.example.com")).toBeNull();
    expect(probeableUrl("http://app.vercel.app")).toBeNull(); // http refused
    expect(probeableUrl("https://vercel.app.evil.com")).toBeNull(); // suffix spoof
    expect(probeableUrl("not a url")).toBeNull();
    expect(probeableUrl(null)).toBeNull();
    process.env.DEPLOY_PROBE_DOMAINS = "status.zapnivo.com";
    expect(probeableUrl("https://status.zapnivo.com/health")).toBe("https://status.zapnivo.com/health");
    expect(probeableUrl("https://other.zapnivo.com")).toBeNull();
  });
});

/* ── Aggregation ───────────────────────────────────────────────────────── */

describe("listDeployments", () => {
  it("merges provider + request records; unconfigured provider is honest", async () => {
    const reqs = fakeTable({
      select: { data: [reqRow({ id: "r-1", status: "pending", target_env: "preview" })], error: null },
    });
    const db = fakeDb({ system_deployment_requests: reqs });
    const res = await listDeployments(db);
    expect(res.providers.vercel.configured).toBe(false);
    expect(res.providers.github.configured).toBe(false);
    expect(res.deployments).toHaveLength(1);
    expect(res.deployments[0].source).toBe("approval_request");
    expect(res.deployments[0].state).toBe("pending");
  });

  it("includes live vercel deployments when configured", async () => {
    setProviderEnv();
    mockFetch(() => jsonRes({
      deployments: [{ uid: "dpl_9", url: "app-x.vercel.app", readyState: "READY", target: "production", createdAt: 1700000000000, meta: { githubCommitSha: "deadbeef1234", githubCommitRef: "main" } }],
    }));
    const db = fakeDb({ system_deployment_requests: fakeTable({ select: { data: [], error: null } }) });
    const res = await listDeployments(db);
    expect(res.providers.vercel.configured).toBe(true);
    const v = res.deployments.find((d) => d.source === "vercel_api");
    expect(v?.state).toBe("ready");
    expect(v?.env).toBe("production");
    expect(v?.url).toBe("https://app-x.vercel.app");
    expect(v?.commitUrl).toBe("https://github.com/zapnivo/zapnivo-website/commit/deadbeef1234");
  });
});

/* ── requestDeploy gating ──────────────────────────────────────────────── */

describe("requestDeploy", () => {
  it("rejects refs outside the allowlist before touching the db", async () => {
    const db = fakeDb({});
    const res = await requestDeploy(db, requester, { ref: "feature/evil", targetEnv: "preview", justification: "a long enough justification" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it("preview deploy proceeds without change-request approval (medium risk)", async () => {
    const reqs = fakeTable({ singles: [{ data: reqRow({ id: "d-9", status: "pending", target_env: "preview", result: null }), error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: audit });
    const res = await requestDeploy(db, requester, { ref: "main", targetEnv: "preview", justification: "preview the new build" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe("created");
    // ref persisted on the row for execute-time resolution
    const upd = callsOf(reqs).updated.at(-1) as Record<string, unknown>;
    expect((upd.result as Record<string, unknown>).ref).toBe("main");
  });

  it("production deploy requires an approved change request (202 pending)", async () => {
    const changes = fakeTable({ select: { data: [], error: null }, singles: [{ data: { id: "cr-1" }, error: null }] });
    const db = fakeDb({ system_change_requests: changes, system_audit_events: fakeTable() });
    const res = await requestDeploy(db, requester, { ref: "main", targetEnv: "production", justification: "ship v1.4.2 to prod" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe("pending_approval");
    expect(callsOf(changes).inserted[0]).toMatchObject({ risk: "high", action: "deployment.deploy:production" });
  });
});

/* ── execute: provider path ────────────────────────────────────────────── */

describe("executeDeploymentCenterRequest", () => {
  it("falls back to awaiting_manual_deploy when vercel is unconfigured", async () => {
    const reqs = fakeTable({
      singles: [
        { data: reqRow({ status: "approved", result: { ref: "main" } }), error: null }, // getDeploymentRequest
        { data: reqRow({ status: "approved", result: { ref: "main" } }), error: null }, // executeDeploymentRequest re-read
      ],
    });
    const audit = fakeTable();
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: audit });
    const res = await executeDeploymentCenterRequest(db, executor, sessionUser("exe-3"), "d-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.status).toBe("awaiting_manual_deploy");
      expect(res.result.mode).toBe("manual");
    }
  });

  it("production execute REQUIRES a live elevation (403 step_up_required)", async () => {
    setProviderEnv();
    mockFetch(() => jsonRes({ deployments: [] }));
    const reqs = fakeTable({ singles: [{ data: reqRow({ status: "approved", result: { ref: "main" } }), error: null }] });
    const elev = fakeTable({ select: { data: [], error: null } }); // no elevation rows
    const db = fakeDb({ system_deployment_requests: reqs, system_elevations: elev });
    const res = await executeDeploymentCenterRequest(db, executor, sessionUser("exe-3"), "d-1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.code).toBe("step_up_required");
    }
  });

  it("blocks requester self-execution on production even with elevation", async () => {
    setProviderEnv();
    mockFetch(() => jsonRes({ deployments: [] }));
    const reqs = fakeTable({ singles: [{ data: reqRow({ status: "approved", requested_by: "req-1", result: { ref: "main" } }), error: null }] });
    const elev = fakeTable({ select: { data: [liveElevation], error: null } });
    const db = fakeDb({ system_deployment_requests: reqs, system_elevations: elev });
    const res = await executeDeploymentCenterRequest(db, requester, sessionUser("req-1"), "d-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it("production execute with elevation calls Vercel and marks executed", async () => {
    setProviderEnv();
    const fetchSpy = mockFetch((url, init) => {
      if (url.includes("/v13/deployments") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.target).toBe("production");
        expect(body.gitSource.ref).toBe("main");
        return jsonRes({ id: "dpl_exec1", url: "app-git-main-zap.vercel.app" });
      }
      return jsonRes({ deployments: [] });
    });
    const reqs = fakeTable({ singles: [{ data: reqRow({ status: "approved", result: { ref: "main" } }), error: null }] });
    const elev = fakeTable({ select: { data: [liveElevation], error: null } });
    const audit = fakeTable();
    const db = fakeDb({ system_deployment_requests: reqs, system_elevations: elev, system_audit_events: audit });
    const res = await executeDeploymentCenterRequest(db, executor, sessionUser("exe-3"), "d-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.status).toBe("executed");
      if (res.result.status === "executed") {
        expect(res.result.deploymentId).toBe("dpl_exec1");
        expect(res.result.mode).toBe("provider");
      }
    }
    const upd = callsOf(reqs).updated.at(-1) as Record<string, unknown>;
    expect(upd.status).toBe("executed");
    const auditIns = callsOf(audit).inserted.map((r) => (r as Record<string, unknown>).action);
    expect(auditIns).toContain("deployment.executed");
    // No token material anywhere in audit detail
    const detail = JSON.stringify(callsOf(audit).inserted);
    expect(detail).not.toContain("vercel-secret-token-abc");
    expect(detail).not.toContain("ghp_testtoken456");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("preview request executes from PENDING without elevation", async () => {
    setProviderEnv();
    mockFetch((url, init) => {
      if (init?.method === "POST") return jsonRes({ id: "dpl_prev1", url: "app-git-main-zap.vercel.app" });
      return jsonRes({ deployments: [] });
    });
    const reqs = fakeTable({ singles: [{ data: reqRow({ status: "pending", target_env: "preview", result: { ref: "main" } }), error: null }] });
    const db = fakeDb({ system_deployment_requests: reqs, system_elevations: fakeTable(), system_audit_events: fakeTable() });
    const res = await executeDeploymentCenterRequest(db, requester, sessionUser("req-1"), "d-1"); // requester may execute own preview
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.status).toBe("executed");
  });

  it("provider failure returns provider_error and does NOT mark executed", async () => {
    setProviderEnv();
    mockFetch((url, init) => {
      if (init?.method === "POST") return jsonRes({ error: { code: "bad_request", message: "gitSource.repoId invalid" } }, 400);
      return jsonRes({ deployments: [] });
    });
    const reqs = fakeTable({ singles: [{ data: reqRow({ status: "approved", target_env: "preview", result: { ref: "main" } }), error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_deployment_requests: reqs, system_elevations: fakeTable(), system_audit_events: audit });
    const res = await executeDeploymentCenterRequest(db, executor, sessionUser("exe-3"), "d-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.status).toBe("provider_error");
      if (res.result.status === "provider_error") expect(res.result.error).toMatch(/repoId|HTTP 400/i);
    }
    const upd = callsOf(reqs).updated.at(-1) as Record<string, unknown>;
    expect(upd.status).toBeUndefined(); // status untouched on failure
  });
});

/* ── Rollback ──────────────────────────────────────────────────────────── */

describe("rollback", () => {
  it("candidates exclude the newest READY production deployment", async () => {
    setProviderEnv();
    const now = Date.now();
    mockFetch(() => jsonRes({
      deployments: [
        { uid: "dpl_new", url: "a.vercel.app", readyState: "READY", target: "production", createdAt: now },
        { uid: "dpl_mid", url: "b.vercel.app", readyState: "READY", target: "production", createdAt: now - 1000 },
        { uid: "dpl_old", url: "c.vercel.app", readyState: "READY", target: "production", createdAt: now - 2000 },
        { uid: "dpl_prev", url: "d.vercel.app", readyState: "READY", target: null, createdAt: now - 500 }, // preview — excluded
        { uid: "dpl_err", url: "e.vercel.app", readyState: "ERROR", target: "production", createdAt: now - 300 },
      ],
    }));
    const rb = await rollbackCandidates();
    expect(rb.configured && rb.ok).toBe(true);
    if (rb.configured && rb.ok) {
      expect(rb.candidates.map((d) => d.uid)).toEqual(["dpl_mid", "dpl_old"]);
    }
  });

  it("unconfigured provider → candidates report configured:false", async () => {
    const fetchSpy = mockFetch(() => jsonRes({}));
    const rb = await rollbackCandidates();
    expect(rb.configured).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requestRollback rejects ineligible targets when provider is live", async () => {
    setProviderEnv();
    mockFetch(() => jsonRes({
      deployments: [
        { uid: "dpl_new", url: "a.vercel.app", readyState: "READY", target: "production", createdAt: Date.now() },
        { uid: "dpl_old", url: "b.vercel.app", readyState: "READY", target: "production", createdAt: Date.now() - 1000 },
      ],
    }));
    const db = fakeDb({ system_change_requests: fakeTable({ select: { data: [], error: null }, singles: [{ data: { id: "cr-1" }, error: null }] }), system_audit_events: fakeTable() });
    const res = await requestRollback(db, requester, { deploymentId: "dpl_new", justification: "rollback to previous" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

/* ── Misc helpers ──────────────────────────────────────────────────────── */

describe("helpers", () => {
  it("normalizeVercelDeployment rejects malformed payloads", () => {
    expect(normalizeVercelDeployment(null)).toBeNull();
    expect(normalizeVercelDeployment({})).toBeNull();
    const d = normalizeVercelDeployment({ uid: "dpl_x", url: "not a url!!" });
    expect(d?.url).toBeNull();
  });

  it("githubCommitUrl only emits links for configured repo + sha", () => {
    expect(githubCommitUrl("abc1234")).toBeNull(); // no GITHUB_REPO
    process.env.GITHUB_REPO = "o/r";
    expect(githubCommitUrl("abc1234deadbeef")).toBe("https://github.com/o/r/commit/abc1234deadbeef");
    expect(githubCommitUrl("not-a-sha!!")).toBeNull();
  });
});
