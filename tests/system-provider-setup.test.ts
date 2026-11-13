import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  githubScopeLabels,
  parseScopeHeader,
  probeVercelTokenIdentity,
  verifyGithubConnection,
  verifyVercelConnection,
} from "@/lib/system/deploy-provider";
import {
  __resetDeployVerifyCache,
  PROVIDER_SETUP_GUIDE,
  providerSetupView,
  verifyProviderConnection,
  writeCapabilityBadge,
} from "@/lib/system/deploy-verify";

/* ── Env + fetch fixtures (same shape as system-deploy-verify.test.ts) ── */

const ENV_KEYS = [
  "VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID", "VERCEL_GIT_REPO_ID",
  "VERCEL_PROJECT_NAME", "GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_DEPLOY_REFS",
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

const setVercelEnv = () => {
  process.env.VERCEL_TOKEN = "vercel-secret-token-abc";
  process.env.VERCEL_PROJECT_ID = "prj_test123";
};
const setGithubEnv = () => {
  process.env.GITHUB_TOKEN = "ghp_testtoken456";
  process.env.GITHUB_REPO = "zapnivo/zapnivo-website";
};

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
function fakeTable(opts: { singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const calls = { inserted: [] as unknown[] };
  const b: Record<string, unknown> = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "filter"]) {
    b[m] = () => b;
  }
  b.eq = () => b;
  b.limit = () => b;
  b.insert = (row: unknown) => { calls.inserted.push(row); return b; };
  b.update = () => b;
  b.delete = () => b;
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(res, rej);
  (b as { _calls?: typeof calls })._calls = calls;
  return b;
}
function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}
const callsOf = (t: ReturnType<typeof fakeTable>) =>
  (t as unknown as { _calls: { inserted: unknown[] } })._calls;

const actor = { id: "u-1", role: "engineer" };

/* ── Scope header parsing + capability mapping ─────────────────────────── */

describe("scope introspection helpers", () => {
  it("parseScopeHeader splits, trims, dedupes, caps", () => {
    expect(parseScopeHeader("repo, read:org,repo")).toEqual(["repo", "read:org"]);
    expect(parseScopeHeader("")).toEqual([]);
    expect(parseScopeHeader(null)).toEqual([]);
    expect(parseScopeHeader(undefined)).toEqual([]);
    expect(parseScopeHeader("  repo  , , workflow ")).toEqual(["repo", "workflow"]);
  });

  it("githubScopeLabels maps known scopes and passes unknown through", () => {
    const labels = githubScopeLabels(["repo", "read:org", "custom:scope"]);
    expect(labels[0]).toContain("repository");
    expect(labels[1]).toContain("organization");
    expect(labels[2]).toBe("custom:scope");
    expect(githubScopeLabels([])).toEqual([]);
  });
});

/* ── GitHub scope extraction ───────────────────────────────────────────── */

describe("verifyGithubConnection — scope headers", () => {
  it("captures x-oauth-scopes + x-accepted-oauth-scopes into permissions", async () => {
    setGithubEnv();
    mockFetch((url) => {
      if (url.includes("/repos/zapnivo/zapnivo-website") && !url.includes("/pulls") && !url.includes("/commits") && !url.includes("/branches")) {
        return jsonRes(
          { id: 1, full_name: "zapnivo/zapnivo-website", default_branch: "main" },
          200,
          { "x-oauth-scopes": "repo, read:org", "x-accepted-oauth-scopes": "repo" },
        );
      }
      if (url.includes("/pulls")) return jsonRes([]);
      if (url.includes("/commits")) return jsonRes([]);
      if (url.includes("/branches")) return jsonRes([]);
      return jsonRes({}, 404);
    });
    const r = await verifyGithubConnection();
    expect(r.verified).toBe(true);
    expect(r.permissions?.grantedScopes).toEqual(["repo", "read:org"]);
    expect(r.permissions?.acceptedScopes).toEqual(["repo"]);
    expect(r.permissions?.scopeLabels.length).toBe(2);
    expect(r.permissions?.note).toBeNull();
    // GitHub is read-only in this integration — never claims write.
    expect(r.writeCapability).toBe("none");
    expect(r.capabilities).toContain("repo.read");
  });

  it("fine-grained PAT (no scope headers) → honest note, empty scopes", async () => {
    setGithubEnv();
    mockFetch((url) => {
      if (url.includes("/repos/zapnivo/zapnivo-website") && !url.includes("/pulls") && !url.includes("/commits") && !url.includes("/branches")) {
        return jsonRes({ id: 1, full_name: "zapnivo/zapnivo-website" });
      }
      return jsonRes([]);
    });
    const r = await verifyGithubConnection();
    expect(r.verified).toBe(true);
    expect(r.permissions?.grantedScopes).toEqual([]);
    expect(r.permissions?.note).toMatch(/fine-grained PAT/i);
    expect(r.writeCapability).toBe("none");
    // Read success must NOT be presented as write/deploy capability.
    expect(r.writeCapability).not.toBe("proven");
  });
});

/* ── Vercel identity + write honesty ───────────────────────────────────── */

describe("verifyVercelConnection — identity + write capability", () => {
  const vercelFetch = (userRes: Response) => mockFetch((url) => {
    if (url.includes("/v6/deployments")) {
      return jsonRes({ deployments: [{ uid: "dpl_1", url: "app-x.vercel.app", readyState: "READY" }] });
    }
    if (url.includes("/v13/deployments/dpl_1")) return jsonRes({ uid: "dpl_1", readyState: "READY" });
    if (url.includes("/v3/deployments/dpl_1/events")) return jsonRes([]);
    if (url.includes("/v2/user")) return userRes;
    if (url.includes("/v2/teams")) return jsonRes({ teams: [] });
    return jsonRes({}, 404);
  });

  it("probes /v2/user for token identity; write stays unverified", async () => {
    setVercelEnv();
    vercelFetch(jsonRes({ id: "user_123", username: "zapnivo-admin" }));
    const r = await verifyVercelConnection();
    expect(r.verified).toBe(true);
    expect(r.permissions?.identity).toMatchObject({ kind: "user", id: "user_123", label: "zapnivo-admin" });
    expect(r.permissions?.note).toMatch(/no permission introspection/i);
    expect(r.writeCapability).toBe("unverified");
    // Read-verified must never claim deployments write is enabled.
    expect(r.writeCapability).not.toBe("proven");
    expect(r.capabilities).not.toContain("deployments.create");
  });

  it("team-scoped token: /v2/user fails → /v2/teams fallback", async () => {
    setVercelEnv();
    process.env.VERCEL_TEAM_ID = "team_abc";
    mockFetch((url) => {
      if (url.includes("/v6/deployments")) return jsonRes({ deployments: [] });
      if (url.includes("/v2/user")) return jsonRes({ error: { message: "forbidden" } }, 403);
      if (url.includes("/v2/teams/team_abc")) return jsonRes({ id: "team_abc", slug: "zapnivo" });
      if (url.includes("/v2/teams")) return jsonRes({ teams: [{ id: "team_abc", slug: "zapnivo" }] });
      return jsonRes({}, 404);
    });
    const r = await verifyVercelConnection();
    expect(r.verified).toBe(true);
    expect(r.permissions?.identity?.kind).toBe("team");
    expect(r.permissions?.identity?.label).toBe("zapnivo");
  });

  it("probeVercelTokenIdentity returns null when unconfigured", async () => {
    expect(await probeVercelTokenIdentity()).toBeNull();
  });
});

/* ── verifyProviderConnection: audit carries scopes, never tokens ──────── */

describe("verifyProviderConnection — scope audit detail", () => {
  it("audit detail includes scopes + writeCapability; token values never appear", async () => {
    setGithubEnv();
    mockFetch((url) => {
      if (url.includes("/repos/zapnivo/zapnivo-website") && !url.includes("/pulls") && !url.includes("/commits") && !url.includes("/branches")) {
        return jsonRes({ id: 1, full_name: "zapnivo/zapnivo-website" }, 200, { "x-oauth-scopes": "repo" });
      }
      return jsonRes([]);
    });
    const audit = fakeTable();
    const db = fakeDb({ system_audit_events: audit });
    const v = await verifyProviderConnection(db, actor, "github", { force: true });
    expect(v.verified).toBe(true);
    expect(v.permissions?.grantedScopes).toEqual(["repo"]);
    const blob = JSON.stringify(callsOf(audit).inserted);
    expect(blob).toContain('"repo"');
    expect(blob).toContain('"writeCapability":"none"');
    expect(blob).not.toContain("ghp_testtoken456");
  });
});

/* ── Setup guide + badges ──────────────────────────────────────────────── */

describe("provider setup guidance", () => {
  it("guides carry env names, docs URLs, recommended scopes — no secrets", () => {
    for (const id of ["github", "vercel"] as const) {
      const g = PROVIDER_SETUP_GUIDE[id];
      expect(g.requiredEnv.length).toBeGreaterThan(0);
      for (const v of g.envVars) expect(v).toMatch(/^[A-Z0-9_]+$/);
      for (const d of g.docs) expect(d.url).toMatch(/^https:\/\//);
      expect(g.recommendedScopes.length).toBeGreaterThan(10);
      expect(g.writePath.length).toBeGreaterThan(10);
    }
    expect(PROVIDER_SETUP_GUIDE.github.docs.some((d) => d.url.includes("docs.github.com"))).toBe(true);
    expect(PROVIDER_SETUP_GUIDE.vercel.docs.some((d) => d.url.includes("vercel.com/docs"))).toBe(true);
  });

  it("providerSetupView merges readiness + cached verification + guide (no network)", async () => {
    const fetchSpy = mockFetch(() => jsonRes({}));
    const v = providerSetupView("github");
    expect(v.provider).toBe("github");
    expect(v.guide).toBe(PROVIDER_SETUP_GUIDE.github);
    expect(v.readiness.requiredAction).toContain("GITHUB_TOKEN");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("writeCapabilityBadge — read success never implies write", () => {
  it("maps states honestly", () => {
    expect(writeCapabilityBadge("proven").tone).toBe("ok");
    expect(writeCapabilityBadge("unverified").tone).toBe("warn");
    expect(writeCapabilityBadge("unverified").label).toContain("unverified");
    expect(writeCapabilityBadge("none").tone).toBe("muted");
    expect(writeCapabilityBadge(undefined).label).toContain("unknown");
    // A verified READ result can only ever pair with unverified/none — 'proven'
    // is unreachable because verification never performs writes.
    expect(writeCapabilityBadge("unverified").label).not.toContain("enabled");
    expect(writeCapabilityBadge("none").label).not.toContain("enabled");
  });
});
