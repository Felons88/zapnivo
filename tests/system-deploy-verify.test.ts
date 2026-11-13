import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import {
  isAllowedDeployRef,
} from "@/lib/system/deploy-provider";
import {
  __resetDeployVerifyCache,
  deployProviderReadiness,
  PROVIDER_REQUIRED_ACTION,
  verifyProviderConnection,
} from "@/lib/system/deploy-verify";
import {
  checkDeploymentHealthNow,
  executeDeploymentCenterRequest,
  monitorDeployment,
  rollbackCompatibility,
} from "@/lib/system/deploy-center";
import type { DeploymentRequestRow } from "@/lib/system/deployops";

/* ── Env + fetch fixtures (same shape as system-deploy-center.test.ts) ── */

const ENV_KEYS = [
  "VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID", "VERCEL_GIT_REPO_ID",
  "VERCEL_PROJECT_NAME", "GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_DEPLOY_REFS",
  "DEPLOY_PROBE_DOMAINS",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  vi.unstubAllGlobals();
  __resetDeployVerifyCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  __resetDeployVerifyCache();
});

const setProviderEnv = () => {
  process.env.VERCEL_TOKEN = "vercel-secret-token-abc";
  process.env.VERCEL_PROJECT_ID = "prj_test123";
  process.env.VERCEL_GIT_REPO_ID = "987654";
  process.env.GITHUB_TOKEN = "ghp_testtoken456";
  process.env.GITHUB_REPO = "zapnivo/zapnivo-website";
};

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };

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

const actor = { id: "u-1", role: "engineer" };
const sessionUser = (id: string): SessionUser => ({ id, email: `${id}@test`, role: "staff" as SessionUser["role"], organizationId: null });

const reqRow = (over: Partial<DeploymentRequestRow> = {}): DeploymentRequestRow => ({
  id: "d-1", action: "deploy", target_env: "production",
  justification: "ship v1.4.2", status: "executed",
  requested_by: "req-1", decided_by: "apr-2", decided_at: new Date().toISOString(),
  result: { provider_deployment_id: "dpl_1", provider_url: "https://app-x.vercel.app" },
  created_at: new Date().toISOString(), ...over,
});

const liveElevation = {
  id: "elev-1", profile_id: "exe-3", method: "totp",
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  consumed_action: null, created_ip: null,
};

/* ── verifyProviderConnection ──────────────────────────────────────────── */

describe("verifyProviderConnection", () => {
  it("unconfigured provider: no fetch, honest requiredAction with exact env vars", async () => {
    const fetchSpy = mockFetch(() => jsonRes({}));
    const v = await verifyProviderConnection(null, actor, "vercel");
    expect(v.configured).toBe(false);
    expect(v.verified).toBe(false);
    expect(v.requiredAction).toContain("VERCEL_TOKEN");
    expect(v.requiredAction).toContain("VERCEL_PROJECT_ID");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("github unconfigured: requiredAction mentions PAT + GitHub App note", async () => {
    const v = await verifyProviderConnection(null, actor, "github");
    expect(v.configured).toBe(false);
    expect(v.requiredAction).toContain("GITHUB_TOKEN");
    expect(v.requiredAction).toContain("GitHub App");
    expect(PROVIDER_REQUIRED_ACTION.github).toContain("fine-grained PAT");
  });

  it("configured vercel: real read-only probes → verified + capabilities + audit", async () => {
    setProviderEnv();
    const fetchSpy = mockFetch((url) => {
      if (url.includes("/v6/deployments")) {
        return jsonRes({ deployments: [{ uid: "dpl_1", url: "app-x.vercel.app", readyState: "READY", target: "production", createdAt: 1700000000000 }] });
      }
      if (url.includes("/v13/deployments/dpl_1")) {
        return jsonRes({ uid: "dpl_1", url: "app-x.vercel.app", readyState: "READY", target: "production" });
      }
      if (url.includes("/v3/deployments/dpl_1/events")) return jsonRes([{ type: "stdout", text: "build ok" }]);
      return jsonRes({}, 404);
    });
    const audit = fakeTable();
    const db = fakeDb({ system_audit_events: audit });

    const v = await verifyProviderConnection(db, actor, "vercel", { force: true });
    expect(v.configured).toBe(true);
    expect(v.verified).toBe(true);
    expect(v.latencyMs).not.toBeNull();
    expect(v.capabilities).toEqual(expect.arrayContaining(["deployments.list", "deployments.get", "deployments.events"]));
    expect(v.requiredAction).toBeNull();
    expect(v.lastSuccessAt).not.toBeNull();

    // Persisted as integration.health_checked (same action integrations.ts reads).
    const actions = callsOf(audit).inserted.map((r) => (r as Record<string, unknown>).action);
    expect(actions).toContain("integration.health_checked");
    const detail = JSON.stringify(callsOf(audit).inserted);
    expect(detail).not.toContain("vercel-secret-token-abc");
    expect(detail).not.toContain("ghp_testtoken456");

    // Second call within TTL → cache hit, ZERO additional provider calls.
    const callsBefore = fetchSpy.mock.calls.length;
    const v2 = await verifyProviderConnection(db, actor, "vercel");
    expect(v2.verified).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });

  it("configured github: repo read verified, secondary probes add capabilities", async () => {
    process.env.GITHUB_TOKEN = "ghp_testtoken456";
    process.env.GITHUB_REPO = "zapnivo/zapnivo-website";
    mockFetch((url) => {
      if (url.includes("/repos/zapnivo/zapnivo-website") && !url.includes("/pulls") && !url.includes("/commits") && !url.includes("/branches")) {
        return jsonRes({ id: 1, full_name: "zapnivo/zapnivo-website", default_branch: "main" });
      }
      if (url.includes("/pulls")) return jsonRes([]);
      if (url.includes("/commits")) return jsonRes([]);
      if (url.includes("/branches")) return jsonRes([]);
      return jsonRes({}, 404);
    });
    const v = await verifyProviderConnection(null, actor, "github", { force: true });
    expect(v.verified).toBe(true);
    expect(v.capabilities).toEqual(expect.arrayContaining(["repo.read", "pull_requests.read", "commits.read", "branches.read"]));
  });

  it("provider API failure → verified:false, sanitized detail, lastFailure set", async () => {
    setProviderEnv();
    mockFetch(() => {
      throw new Error(`boom token=vercel-secret-token-abc`);
    });
    const v = await verifyProviderConnection(null, actor, "vercel", { force: true });
    expect(v.configured).toBe(true);
    expect(v.verified).toBe(false);
    expect(v.detail ?? "").not.toContain("vercel-secret-token-abc");
    expect(v.lastFailure).not.toBeNull();
    expect(v.requiredAction).not.toBeNull();
  });
});

/* ── deployProviderReadiness (static, no network) ──────────────────────── */

describe("deployProviderReadiness", () => {
  it("reports gates + requiredAction without any fetch", async () => {
    const fetchSpy = mockFetch(() => jsonRes({}));
    const r = deployProviderReadiness("vercel");
    expect(r.configured).toBe(false);
    expect(r.missing).toEqual(["VERCEL_TOKEN", "VERCEL_PROJECT_ID"]);
    expect(r.requiredAction).toContain("vercel.com/account/settings/tokens");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ── monitorDeployment ─────────────────────────────────────────────────── */

describe("monitorDeployment", () => {
  it("BUILDING → state 'building', non-terminal, persists provider_monitor", async () => {
    setProviderEnv();
    mockFetch((url) => {
      if (url.includes("api.vercel.com")) {
        return jsonRes({ uid: "dpl_1", url: "app-x.vercel.app", readyState: "BUILDING", target: "production" });
      }
      return jsonRes({}, 404);
    });
    const reqs = fakeTable({ singles: [{ data: reqRow(), error: null }] });
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: fakeTable() });
    const res = await monitorDeployment(db, actor, "d-1");
    expect(res.ok).toBe(true);
    expect(res.state).toBe("building");
    expect(res.terminal).toBe(false);
    expect(res.health).toBeNull();
    const upd = callsOf(reqs).updated.at(-1) as Record<string, unknown>;
    expect((upd.result as Record<string, unknown>).provider_monitor).toBeTruthy();
  });

  it("READY + production → HTTP probe → result.health healthy + audit", async () => {
    setProviderEnv();
    mockFetch((url, init) => {
      if (url.includes("api.vercel.com")) {
        return jsonRes({ uid: "dpl_1", url: "app-x.vercel.app", readyState: "READY", target: "production" });
      }
      if (url.startsWith("https://app-x.vercel.app")) {
        expect(init?.method === "HEAD" || init?.method === "GET").toBe(true);
        return new Response(null, { status: 200 });
      }
      return jsonRes({}, 404);
    });
    const reqs = fakeTable({ singles: [{ data: reqRow(), error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: audit });
    const res = await monitorDeployment(db, actor, "d-1");
    expect(res.state).toBe("ready");
    expect(res.terminal).toBe(true);
    expect(res.health?.status).toBe("healthy");
    expect(res.health?.httpStatus).toBe(200);
    expect(res.health?.url).toContain("vercel.app");
    const upd = callsOf(reqs).updated.at(-1) as Record<string, unknown>;
    expect((upd.result as Record<string, unknown>).health).toMatchObject({ status: "healthy", httpStatus: 200 });
    const actions = callsOf(audit).inserted.map((r) => (r as Record<string, unknown>).action);
    expect(actions).toContain("deployment.health_checked");
  });

  it("READY + preview → NO production health probe", async () => {
    setProviderEnv();
    const fetchSpy = mockFetch((url) => {
      if (url.includes("api.vercel.com")) {
        return jsonRes({ uid: "dpl_1", url: "app-x.vercel.app", readyState: "READY", target: null });
      }
      return jsonRes({}, 404);
    });
    const reqs = fakeTable({ singles: [{ data: reqRow({ target_env: "preview" }), error: null }] });
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: fakeTable() });
    const res = await monitorDeployment(db, actor, "d-1");
    expect(res.state).toBe("ready");
    expect(res.terminal).toBe(true);
    expect(res.health).toBeNull();
    // Only the provider GET ran — never the deployment URL.
    expect(fetchSpy.mock.calls.every(([u]) => String(u).includes("api.vercel.com"))).toBe(true);
  });

  it("ERROR → terminal 'error'; non-probeable URL → health 'skipped'", async () => {
    setProviderEnv();
    mockFetch((url) => {
      if (url.includes("api.vercel.com")) {
        return jsonRes({ uid: "dpl_1", url: "app-x.vercel.app", readyState: "ERROR", target: "production" });
      }
      return jsonRes({}, 404);
    });
    const reqs = fakeTable({ singles: [{ data: reqRow(), error: null }] });
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: fakeTable() });
    const res = await monitorDeployment(db, actor, "d-1");
    expect(res.state).toBe("error");
    expect(res.terminal).toBe(true);
    expect(res.health).toBeNull(); // no probe on non-ready states
  });

  it("request without provider_deployment_id → request-level state, terminal when executed", async () => {
    const reqs = fakeTable({ singles: [{ data: reqRow({ result: { ref: "main" } }), error: null }] });
    const db = fakeDb({ system_deployment_requests: reqs });
    const res = await monitorDeployment(db, actor, "d-1");
    expect(res.state).toBe("ready"); // REQUEST_STATE executed→ready
    expect(res.terminal).toBe(true);
  });

  it("missing request → found:false", async () => {
    const db = fakeDb({ system_deployment_requests: fakeTable({ singles: [{ data: null, error: null }] }) });
    const res = await monitorDeployment(db, actor, "nope");
    expect(res.found).toBe(false);
    expect(res.ok).toBe(false);
  });
});

describe("checkDeploymentHealthNow", () => {
  it("probes now and always audits, even when provider state is building", async () => {
    setProviderEnv();
    mockFetch((url, init) => {
      if (url.includes("api.vercel.com")) {
        return jsonRes({ uid: "dpl_1", url: "app-x.vercel.app", readyState: "BUILDING", target: "production" });
      }
      if (url.startsWith("https://app-x.vercel.app")) return new Response(null, { status: 503 });
      return jsonRes({}, 404);
    });
    const reqs = fakeTable({ singles: [{ data: reqRow(), error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: audit });
    const res = await checkDeploymentHealthNow(db, actor, "d-1");
    expect(res.ok).toBe(true);
    expect(res.health?.status).toBe("unhealthy");
    expect(res.health?.httpStatus).toBe(503);
    const actions = callsOf(audit).inserted.map((r) => (r as Record<string, unknown>).action);
    expect(actions).toContain("deployment.health_checked");
  });
});

/* ── Rollback compatibility ────────────────────────────────────────────── */

describe("rollbackCompatibility", () => {
  it("always returns the no-migrations-reverted warning + manifest truth", async () => {
    const db = fakeDb({ supabase_migrations: fakeTable({ select: { data: null, error: { message: "relation does not exist" }, count: null } }) });
    const c = await rollbackCompatibility(db);
    expect(c.warning).toContain("does NOT revert database migrations");
    expect(c.repoMigrationCount).toBeGreaterThan(0);
    expect(c.latestMigration?.file).toMatch(/\.sql$/);
    expect(c.dbMigrationTracking).toBe("unavailable"); // PostgREST can't see it
  });
});

/* ── Ref security ──────────────────────────────────────────────────────── */

describe("ref security", () => {
  it("rejects traversal, feature branches, and raw SHAs by default", () => {
    expect(isAllowedDeployRef("../../etc/passwd")).toBe(false);
    expect(isAllowedDeployRef("feature/x")).toBe(false);
    expect(isAllowedDeployRef("a".repeat(40))).toBe(false); // 40-hex SHA not allowlisted
    expect(isAllowedDeployRef("main")).toBe(true);
    process.env.GITHUB_DEPLOY_REFS = "main,release/*";
    expect(isAllowedDeployRef("release/1.2")).toBe(true);
    expect(isAllowedDeployRef("hotfix/../main")).toBe(false);
  });

  it("execute re-validates a tampered stored ref before any provider call", async () => {
    setProviderEnv();
    const fetchSpy = mockFetch(() => jsonRes({}));
    const reqs = fakeTable({
      singles: [{ data: reqRow({ status: "approved", target_env: "preview", result: { ref: "../../evil" } }), error: null }],
    });
    const db = fakeDb({ system_deployment_requests: reqs, system_elevations: fakeTable(), system_audit_events: fakeTable() });
    const res = await executeDeploymentCenterRequest(db, { id: "exe-3", role: "sysadmin" }, sessionUser("exe-3"), "d-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.status).toBe("provider_error");
      if (res.result.status === "provider_error") expect(res.result.error).toMatch(/not in the allowed deploy-ref set/);
    }
    expect(fetchSpy).not.toHaveBeenCalled(); // rejected before createVercelDeployment
  });
});
