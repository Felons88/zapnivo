import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  APP_PROFILES,
  healthProfileApps,
  healthProfileFor,
  healthUrlAllowed,
  runAndRecordHealthProfile,
  runHealthProfile,
} from "@/lib/system/deploy-health";
import { migrationCompatNote, monitorDeployment } from "@/lib/system/deploy-center";
import type { DeploymentRequestRow } from "@/lib/system/deployops";

/* ── Env + fetch fixtures ──────────────────────────────────────────────── */

const ENV_KEYS = ["DEPLOY_PROBE_DOMAINS", "BASE_DOMAIN", "VERCEL_TOKEN", "VERCEL_PROJECT_ID"];
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

const res = (status: number, body = "", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/* ── Minimal Supabase stub (same shape as system-deploy-center.test.ts) ── */

type Result = { data?: unknown; error?: { message: string } | null };

function fakeTable(opts: { singles?: Result[]; select?: Result } = {}) {
  const singles = [...(opts.singles ?? [])];
  const calls = { inserted: [] as unknown[], updated: [] as unknown[] };
  const b: Record<string, unknown> = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "filter"]) {
    b[m] = () => b;
  }
  b.eq = () => b;
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
const callsOf = (t: ReturnType<typeof fakeTable>) => (t as unknown as { _calls: { inserted: unknown[]; updated: unknown[] } })._calls;

/* ── Profile definitions ───────────────────────────────────────────────── */

describe("APP_PROFILES definitions", () => {
  it("covers the 7 production hosts", () => {
    expect(APP_PROFILES.map((p) => p.app).sort()).toEqual(
      ["api", "customer", "internal", "partners", "support", "system", "www"],
    );
    expect(healthProfileApps()).toHaveLength(7);
  });

  it("every check has a valid kind, safe path, and consistent expect type", () => {
    const kinds = new Set(["http_status", "auth_gate", "redirect", "no_cross_host_redirect", "api_readonly"]);
    for (const p of APP_PROFILES) {
      expect(p.checks.length).toBeGreaterThan(0);
      for (const c of p.checks) {
        expect(kinds.has(c.kind)).toBe(true);
        const path = c.path ?? "/";
        expect(path.startsWith("/")).toBe(true);
        expect(path.startsWith("//")).toBe(false);
        expect(path).not.toContain("..");
        if (["http_status", "api_readonly", "no_cross_host_redirect"].includes(c.kind)) {
          expect(Array.isArray(c.expect)).toBe(true);
        }
        if (c.kind === "auth_gate") {
          expect(["login_redirect", "auth_wall"]).toContain(c.expect);
        }
      }
    }
  });

  it("hosts resolve under the base domain and lookups/aliases work", () => {
    const www = healthProfileFor("www");
    expect(www?.host).toBe("www.zapnivo.com");
    expect(healthProfileFor("apex")?.host).toBe("www.zapnivo.com"); // alias
    expect(healthProfileFor("api")?.host).toBe("api.zapnivo.com");
    expect(healthProfileFor("system")?.host).toBe("system.zapnivo.com");
    expect(healthProfileFor("bogus")).toBeNull();
  });
});

/* ── URL allowlist ─────────────────────────────────────────────────────── */

describe("healthUrlAllowed", () => {
  it("allows only https on approved hosts", () => {
    expect(healthUrlAllowed("https://www.zapnivo.com/")).toBe(true);
    expect(healthUrlAllowed("https://deep.sub.zapnivo.com/x")).toBe(true);
    expect(healthUrlAllowed("https://app-git-main.vercel.app")).toBe(true);
    expect(healthUrlAllowed("https://evil.com")).toBe(false);
    expect(healthUrlAllowed("https://zapnivo.com.evil.com")).toBe(false);
    expect(healthUrlAllowed("http://www.zapnivo.com/")).toBe(false);
    expect(healthUrlAllowed("not a url")).toBe(false);
    process.env.DEPLOY_PROBE_DOMAINS = "status.example.net";
    expect(healthUrlAllowed("https://status.example.net/health")).toBe(true);
    expect(healthUrlAllowed("https://other.example.net")).toBe(false);
  });
});

/* ── Runner ────────────────────────────────────────────────────────────── */

describe("runHealthProfile", () => {
  it("healthy when every check passes (incl. auth gates + api 401s)", async () => {
    const fetchSpy = mockFetch((url) => {
      if (url.includes("/api/system/status")) return res(401);
      if (url === "https://www.zapnivo.com/") return res(200, "<html>home</html>");
      return res(200);
    });
    const out = await runHealthProfile("www");
    expect(out.status).toBe("healthy");
    expect(out.checksOk).toBe(out.checksTotal);
    expect(out.criticalFailures).toEqual([]);
    // Every fetched URL stayed on the approved host — no arbitrary URLs.
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/(www\.zapnivo\.com|.*\.vercel\.app)/);
    }
  });

  it("auth_gate accepts a same-host redirect to /login", async () => {
    mockFetch((url) => {
      if (url.includes("/api/system/status")) return res(401);
      return res(307, "", { location: "/login?next=%2F" });
    });
    const out = await runHealthProfile("internal");
    expect(out.status).toBe("healthy");
    const gate = out.checks.find((c) => c.id === "root_gate");
    expect(gate?.ok).toBe(true);
    expect(gate?.status).toBe(307);
  });

  it("auth_gate FAILS when the portal serves 200 to anonymous (gate broken)", async () => {
    mockFetch(() => res(200, "<html>portal content</html>"));
    const out = await runHealthProfile("partners");
    expect(out.status).toBe("degraded"); // root_gate is critical
    expect(out.criticalFailures).toContain("root_gate");
  });

  it("auth_wall requires the restricted marker — bare 200 without it fails", async () => {
    mockFetch((url) => {
      if (url.includes("/api/system/status")) return res(401);
      if (url === "https://system.zapnivo.com/") return res(200, "<html>Access restricted</html>");
      return res(200, "<html>console dashboard</html>"); // /system without marker → fail (info)
    });
    const out = await runHealthProfile("system");
    expect(out.status).toBe("healthy"); // only informational check failed
    expect(out.informationalFailures).toContain("system_path_wall");
  });

  it("critical failure → degraded; informational-only failure → healthy", async () => {
    mockFetch((url) => {
      if (url === "https://www.zapnivo.com/") return res(500);
      if (url === "https://www.zapnivo.com/locations") return res(404);
      return res(401);
    });
    const out = await runHealthProfile("www");
    expect(out.status).toBe("degraded");
    expect(out.criticalFailures).toEqual(["home"]);
    expect(out.informationalFailures).toContain("locations");
  });

  it("no HTTP response at all → unreachable (not degraded)", async () => {
    mockFetch(() => { throw new Error("ECONNREFUSED"); });
    const out = await runHealthProfile("api");
    expect(out.status).toBe("unreachable");
    expect(out.checks.every((c) => !c.responded && c.status === null)).toBe(true);
  });

  it("timeout is reported per-check without throwing", async () => {
    mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
    }));
    const out = await runHealthProfile("support", { timeoutMs: 30 });
    expect(out.status).toBe("unreachable");
    expect(out.checks[0].detail).toMatch(/timed out|no HTTP response/);
  });

  it("rejects unknown app keys", async () => {
    await expect(runHealthProfile("bogus")).rejects.toThrow(/unknown health profile/);
  });
});

/* ── Recording + audit ─────────────────────────────────────────────────── */

describe("runAndRecordHealthProfile", () => {
  it("writes uptime_checks rows + deployment.health_profile audit", async () => {
    mockFetch((url) => (url.includes("/api/system/status") ? res(401) : res(200)));
    const uptime = fakeTable();
    const audit = fakeTable();
    const db = fakeDb({ uptime_checks: uptime, system_audit_events: audit });
    const out = await runAndRecordHealthProfile(db, { id: "u-1", role: "engineer" }, "www");
    expect(out.status).toBe("healthy");
    // one uptime_checks insert call carrying all check rows
    const batch = callsOf(uptime).inserted[0] as Record<string, unknown>[];
    expect(batch).toHaveLength(out.checksTotal);
    expect(batch[0]).toMatchObject({ ok: true });
    const actions = callsOf(audit).inserted.map((r) => (r as Record<string, unknown>).action);
    expect(actions).toContain("deployment.health_profile");
    expect(actions).not.toContain("deployment.health_degraded"); // healthy → no degraded audit
  });

  it("audits deployment.health_degraded on transition to degraded", async () => {
    mockFetch(() => res(503));
    const audit = fakeTable();
    const db = fakeDb({ uptime_checks: fakeTable(), system_audit_events: audit });
    const out = await runAndRecordHealthProfile(db, { id: "u-1", role: "engineer" }, "www", { prevStatus: "healthy" });
    expect(out.status).toBe("degraded");
    const actions = callsOf(audit).inserted.map((r) => (r as Record<string, unknown>).action);
    expect(actions).toContain("deployment.health_profile");
    expect(actions).toContain("deployment.health_degraded");
  });
});

/* ── deploy-center integration ─────────────────────────────────────────── */

describe("monitorDeployment health-profile integration", () => {
  const reqRow = (over: Partial<DeploymentRequestRow> = {}): DeploymentRequestRow => ({
    id: "d-1", action: "deploy", target_env: "production",
    justification: "ship it", status: "executed",
    requested_by: "req-1", decided_by: "apr-2", decided_at: new Date().toISOString(),
    result: { provider_deployment_id: "dpl_1", provider_url: "https://app-x.vercel.app", ref: "main" },
    created_at: new Date().toISOString(), ...over,
  });

  it("READY+production monitor stores result.healthProfile (www profile)", async () => {
    process.env.VERCEL_TOKEN = "vercel-secret-token-abc";
    process.env.VERCEL_PROJECT_ID = "prj_test123";
    mockFetch((url, init) => {
      if (url.includes("api.vercel.com")) {
        return res(200, JSON.stringify({
          uid: "dpl_1", url: "app-x.vercel.app", readyState: "READY", target: "production",
          createdAt: Date.now(), meta: {},
        }));
      }
      if (url.includes("vercel.app")) return res(200);
      if (url.includes("/api/system/status")) return res(401);
      return res(200);
    });
    const reqs = fakeTable({ singles: [{ data: reqRow(), error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: audit, uptime_checks: fakeTable() });
    const out = await monitorDeployment(db, { id: "exe-3", role: "sysadmin" }, "d-1");
    expect(out.ok).toBe(true);
    expect(out.state).toBe("ready");
    expect(out.healthProfile).not.toBeNull();
    expect(out.healthProfile?.app).toBe("www");
    expect(out.healthProfile?.status).toBe("healthy");
    // persisted on the request result
    const lastUpdate = callsOf(reqs).updated.at(-1) as Record<string, unknown>;
    expect((lastUpdate.result as Record<string, unknown>).healthProfile).toBeTruthy();
  });

  it("does NOT run the profile when a fresh one is already stored", async () => {
    process.env.VERCEL_TOKEN = "vercel-secret-token-abc";
    process.env.VERCEL_PROJECT_ID = "prj_test123";
    const fresh = {
      app: "www", host: "www.zapnivo.com", ranAt: new Date().toISOString(),
      status: "healthy", checks: [], checksOk: 0, checksTotal: 0,
      criticalFailures: [], informationalFailures: [],
    };
    const fetchSpy = mockFetch((url) => {
      if (url.includes("api.vercel.com")) {
        return res(200, JSON.stringify({ uid: "dpl_1", url: "app-x.vercel.app", readyState: "READY", target: "production", createdAt: Date.now(), meta: {} }));
      }
      return res(200);
    });
    const reqs = fakeTable({
      singles: [{ data: reqRow({ result: { provider_deployment_id: "dpl_1", provider_url: "https://app-x.vercel.app", healthProfile: fresh } }), error: null }],
    });
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: fakeTable(), uptime_checks: fakeTable() });
    const out = await monitorDeployment(db, { id: "exe-3", role: "sysadmin" }, "d-1");
    expect(out.healthProfile?.ranAt).toBe(fresh.ranAt);
    // only vercel.app probe fetches — no zapnivo.com profile fetches
    const zapnivoCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("zapnivo.com"));
    expect(zapnivoCalls).toHaveLength(0);
  });
});

/* ── Rollback candidate annotation ─────────────────────────────────────── */

describe("migrationCompatNote", () => {
  it("annotates age + latest migration honestly (never claims compat)", () => {
    const note = migrationCompatNote({ createdAt: Date.now() - 10 * 86_400_000 });
    expect(note.ageDays).toBe(10);
    expect(note.latestMigrationFile).toMatch(/^00\d\d_.*\.sql$/);
    expect(note.note).toMatch(/never reverts migrations/i);
    expect(note.note).toContain(note.latestMigrationFile ?? "");
    const undated = migrationCompatNote({ createdAt: null });
    expect(undated.ageDays).toBeNull();
  });
});
