import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  derivePipelineStages,
  PIPELINE_STAGE_IDS,
  type PipelineInput,
} from "@/lib/system/deploy-pipeline";
import { getAppHealthSummary } from "@/lib/system/app-health";
import type { DeploymentRequestRow } from "@/lib/system/deployops";

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const T0 = "2025-01-01T00:00:00.000Z";
const T1 = "2025-01-01T00:10:00.000Z";
const T2 = "2025-01-01T00:20:00.000Z";
const T3 = "2025-01-01T00:30:00.000Z";

function reqRow(over: Partial<DeploymentRequestRow> = {}): DeploymentRequestRow {
  return {
    id: "req-1",
    action: "deploy",
    target_env: "production",
    justification: "ship the thing",
    status: "pending",
    requested_by: "user-requester",
    decided_by: null,
    decided_at: null,
    result: { ref: "main", provider: "vercel" },
    created_at: T0,
    ...over,
  };
}

const stageOf = (p: ReturnType<typeof derivePipelineStages>, id: string) =>
  p.stages.find((s) => s.id === id)!;

describe("derivePipelineStages — stage coverage", () => {
  it("covers the full stage list in order", () => {
    const p = derivePipelineStages({ request: reqRow() });
    expect(p.stages.map((s) => s.id)).toEqual([...PIPELINE_STAGE_IDS]);
  });
});

describe("derivePipelineStages — request lifecycle", () => {
  it("requested-only (pending): early stages done/active, production pending", () => {
    const p = derivePipelineStages({ request: reqRow({ status: "pending" }) });
    expect(stageOf(p, "requested").status).toBe("done");
    expect(stageOf(p, "source_validated").status).toBe("done");
    expect(stageOf(p, "checks_passed").status).toBe("done");
    expect(stageOf(p, "review_pending").status).toBe("active");
    expect(stageOf(p, "approved").status).toBe("pending");
    // production target → preview stages skipped, not fabricated
    expect(stageOf(p, "preview_building").status).toBe("skipped");
    expect(stageOf(p, "preview_building").reason).toMatch(/no preview stage/);
    expect(stageOf(p, "production_deploying").status).toBe("pending");
    expect(stageOf(p, "health_verified").status).toBe("unknown");
    expect(p.outcome).toBe("in_progress");
    expect(p.env).toBe("production");
    expect(p.initiator).toBe("user-requester");
    expect(p.approver).toBeNull();
  });

  it("approved-not-executed: approved done, production stages pending (manual path honest)", () => {
    const p = derivePipelineStages({
      request: reqRow({ status: "approved", decided_by: "user-approver", decided_at: T1 }),
    });
    expect(stageOf(p, "review_pending").status).toBe("done");
    expect(stageOf(p, "approved").status).toBe("done");
    expect(stageOf(p, "approved").at).toBe(T1);
    expect(stageOf(p, "production_deploying").status).toBe("pending");
    expect(stageOf(p, "production_deploying").reason).toMatch(/awaiting execution/);
    expect(stageOf(p, "production_ready").status).toBe("pending");
    expect(p.outcome).toBe("in_progress");
    expect(p.approver).toBe("user-approver");
    expect(p.decidedAt).toBe(T1);
  });

  it("rejected request → canceled outcome, approved stage failed", () => {
    const p = derivePipelineStages({
      request: reqRow({ status: "rejected", decided_by: "user-approver", decided_at: T1 }),
    });
    expect(stageOf(p, "approved").status).toBe("failed");
    expect(stageOf(p, "production_deploying").status).toBe("skipped");
    expect(stageOf(p, "completed").status).toBe("skipped");
    expect(p.outcome).toBe("canceled");
  });

  it("failed request → failed outcome", () => {
    const p = derivePipelineStages({
      request: reqRow({ status: "failed", decided_by: "a", decided_at: T1 }),
    });
    expect(stageOf(p, "production_deploying").status).toBe("failed");
    expect(p.outcome).toBe("failed");
  });
});

describe("derivePipelineStages — provider + health evidence", () => {
  const executedReq = () => reqRow({
    status: "executed",
    decided_by: "user-approver",
    decided_at: T1,
    result: {
      ref: "main",
      provider: "vercel",
      provider_deployment_id: "dpl_abc123",
      provider_url: "https://app-x.vercel.app",
      executed_at: T2,
      executed_by: "user-executor",
    },
  });

  const providerReady = {
    deploymentId: "dpl_abc123",
    url: "https://app-x.vercel.app",
    state: "ready" as const,
    stateRaw: "READY",
    commitSha: "abc123def456",
    checkedAt: T3,
  };

  it("executed + provider ready + healthy probe → completed", () => {
    const p = derivePipelineStages({
      request: executedReq(),
      provider: providerReady,
      health: { status: "healthy", checkedAt: T3, httpStatus: 200 },
    });
    expect(stageOf(p, "production_deploying").status).toBe("done");
    expect(stageOf(p, "production_ready").status).toBe("done");
    expect(stageOf(p, "health_verified").status).toBe("done");
    expect(stageOf(p, "completed").status).toBe("done");
    expect(p.outcome).toBe("completed");
    expect(p.commitSha).toBe("abc123def456");
    expect(p.providerDeploymentId).toBe("dpl_abc123");
    expect(p.providerUrl).toBe("https://app-x.vercel.app");
    expect(p.executedAt).toBe(T2);
  });

  it("executed + provider ready + unhealthy probe → health_verified failed", () => {
    const p = derivePipelineStages({
      request: executedReq(),
      provider: providerReady,
      health: { status: "unhealthy", checkedAt: T3, httpStatus: 503 },
    });
    expect(stageOf(p, "health_verified").status).toBe("failed");
    expect(stageOf(p, "completed").status).toBe("skipped");
    expect(p.outcome).toBe("failed");
  });

  it("degraded app health profile fails health_verified even without a probe", () => {
    const p = derivePipelineStages({
      request: executedReq(),
      provider: providerReady,
      healthProfile: { status: "degraded", ranAt: T3, criticalFailures: 1 },
    });
    expect(stageOf(p, "health_verified").status).toBe("failed");
    expect(stageOf(p, "health_verified").reason).toMatch(/critical/);
    expect(p.outcome).toBe("failed");
  });

  it("healthy profile can verify health when no per-deploy probe exists", () => {
    const p = derivePipelineStages({
      request: executedReq(),
      provider: providerReady,
      healthProfile: { status: "healthy", ranAt: T3, criticalFailures: 0 },
    });
    expect(stageOf(p, "health_verified").status).toBe("done");
    expect(p.outcome).toBe("completed");
  });

  it("provider building → production_deploying active, ready pending", () => {
    const p = derivePipelineStages({
      request: executedReq(),
      provider: { ...providerReady, state: "building", stateRaw: "BUILDING" },
    });
    expect(stageOf(p, "production_deploying").status).toBe("active");
    expect(stageOf(p, "production_ready").status).toBe("pending");
    expect(p.outcome).toBe("in_progress");
  });

  it("provider error → production stages failed, outcome failed", () => {
    const p = derivePipelineStages({
      request: executedReq(),
      provider: { ...providerReady, state: "error", stateRaw: "ERROR" },
    });
    expect(stageOf(p, "production_deploying").status).toBe("failed");
    expect(stageOf(p, "production_ready").status).toBe("failed");
    expect(p.outcome).toBe("failed");
  });

  it("provider canceled → outcome canceled", () => {
    const p = derivePipelineStages({
      request: executedReq(),
      provider: { ...providerReady, state: "canceled", stateRaw: "CANCELED" },
    });
    expect(p.outcome).toBe("canceled");
  });
});

describe("derivePipelineStages — honesty / unknown evidence", () => {
  it("executed request with NO provider evidence → ready unknown, not done", () => {
    const p = derivePipelineStages({
      request: reqRow({
        status: "executed",
        decided_by: "a", decided_at: T1,
        result: { ref: "main", provider_deployment_id: "dpl_x", executed_at: T2 },
      }),
    });
    expect(stageOf(p, "production_deploying").status).toBe("done"); // provider accepted
    expect(stageOf(p, "production_deploying").reason).toMatch(/unverified/);
    expect(stageOf(p, "production_ready").status).toBe("unknown"); // NOT claimed ready
    expect(stageOf(p, "health_verified").status).toBe("unknown");
    expect(p.outcome).toBe("unknown");
  });

  it("provider-only record (no request) → request/review stages skipped or unknown", () => {
    const p = derivePipelineStages({
      request: null,
      env: "production",
      provider: {
        deploymentId: "dpl_only", url: "https://x.vercel.app",
        state: "ready", stateRaw: "READY", commitSha: null, checkedAt: T3,
      },
    });
    expect(stageOf(p, "requested").status).toBe("skipped");
    expect(stageOf(p, "review_pending").status).toBe("unknown");
    expect(stageOf(p, "approved").status).toBe("unknown");
    expect(stageOf(p, "production_ready").status).toBe("done");
    expect(stageOf(p, "health_verified").status).toBe("unknown"); // no probe recorded
    expect(p.outcome).toBe("unknown"); // cannot claim completed without health
    expect(p.commitSha).toBeNull();
  });

  it("deploy request missing ref → source_validated unknown", () => {
    const p = derivePipelineStages({
      request: reqRow({ result: { provider: "vercel" } }), // no ref
    });
    expect(stageOf(p, "source_validated").status).toBe("unknown");
    expect(stageOf(p, "source_validated").reason).toMatch(/no recorded ref/);
  });

  it("rollback request validates via target_deployment_id", () => {
    const p = derivePipelineStages({
      request: reqRow({
        action: "rollback",
        status: "approved", decided_by: "a", decided_at: T1,
        result: { target_deployment_id: "dpl_old999", provider: "vercel" },
      }),
    });
    expect(stageOf(p, "source_validated").status).toBe("done");
    expect(stageOf(p, "source_validated").reason).toMatch(/dpl_old999/);
  });

  it("preview target → preview stages live, production stages skipped", () => {
    const p = derivePipelineStages({
      request: reqRow({ target_env: "preview", status: "approved", decided_by: "a", decided_at: T1 }),
      provider: {
        deploymentId: "dpl_prev", url: "https://prev.vercel.app",
        state: "building", stateRaw: "BUILDING", commitSha: "ff00", checkedAt: T2,
      },
    });
    expect(stageOf(p, "preview_building").status).toBe("active");
    expect(stageOf(p, "preview_ready").status).toBe("pending");
    expect(stageOf(p, "production_deploying").status).toBe("skipped");
    expect(p.env).toBe("preview");
  });

  it("empty input → everything unknown, outcome unknown", () => {
    const p = derivePipelineStages({ request: null });
    expect(p.stages.every((s) => s.status === "unknown" || s.status === "skipped")).toBe(true);
    expect(p.outcome).toBe("unknown");
  });
});

/* ── app-health aggregation ────────────────────────────────────────────── */

type Result = { data?: unknown; error?: { message: string } | null };

function fakeTable(select: Result) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "filter", "limit"]) {
    b[m] = () => b;
  }
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(select).then(res, rej);
  return b;
}

function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable({ data: [], error: null }) } as unknown as SupabaseClient;
}

const auditRow = (app: string, detail: Record<string, unknown>, created_at = T3) => ({
  resource: `health_profile:${app}`,
  created_at,
  detail,
});

describe("getAppHealthSummary", () => {
  it("db=null → configured:false, all apps unverified", async () => {
    const s = await getAppHealthSummary(null);
    expect(s.configured).toBe(false);
    expect(s.apps).toHaveLength(7);
    expect(s.apps.every((a) => a.state === "unverified" && a.source === "none")).toBe(true);
  });

  it("uses health-profile audit verdicts with critical weighting", async () => {
    const db = fakeDb({
      system_audit_events: fakeTable({
        data: [
          auditRow("www", { health_status: "degraded", checks_ok: 2, checks_total: 3, critical_failures: ["home"] }),
          auditRow("api", { health_status: "healthy", checks_ok: 3, checks_total: 3, critical_failures: [] }),
        ],
        error: null,
      }),
      uptime_checks: fakeTable({ data: [], error: null }),
    });
    const s = await getAppHealthSummary(db);
    const www = s.apps.find((a) => a.app === "www")!;
    const api = s.apps.find((a) => a.app === "api")!;
    const support = s.apps.find((a) => a.app === "support")!;
    expect(www.state).toBe("degraded");
    expect(www.criticalFailures).toBe(1);
    expect(www.checksOk).toBe(2);
    expect(www.checksTotal).toBe(3);
    expect(www.source).toBe("health_profile");
    expect(www.checkedAt).toBe(T3);
    expect(api.state).toBe("healthy");
    expect(support.state).toBe("unverified"); // no evidence → honest
    expect(support.criticalFailures).toBeNull();
  });

  it("falls back to uptime_checks when no profile audit exists", async () => {
    const db = fakeDb({
      system_audit_events: fakeTable({ data: [], error: null }),
      uptime_checks: fakeTable({
        data: [
          // customer.zapnivo.com — all probes ok → healthy (weaker source)
          { url: "https://customer.zapnivo.com/", ok: true, status_code: 307, checked_at: T3 },
          { url: "https://customer.zapnivo.com/account", ok: true, status_code: 307, checked_at: T3 },
          // support.zapnivo.com — every probe failed w/o HTTP response → unreachable
          { url: "https://support.zapnivo.com/", ok: false, status_code: null, checked_at: T3 },
          { url: "https://support.zapnivo.com/support/articles", ok: false, status_code: null, checked_at: T3 },
        ],
        error: null,
      }),
    });
    const s = await getAppHealthSummary(db);
    const customer = s.apps.find((a) => a.app === "customer")!;
    const support = s.apps.find((a) => a.app === "support")!;
    const www = s.apps.find((a) => a.app === "www")!;
    expect(customer.state).toBe("healthy");
    expect(customer.source).toBe("uptime_checks");
    expect(customer.criticalFailures).toBeNull(); // no criticality in raw rows
    expect(support.state).toBe("unreachable");
    expect(www.state).toBe("unverified");
  });

  it("uptime_checks with mixed ok/fail → degraded, criticalFailures stays null", async () => {
    const db = fakeDb({
      system_audit_events: fakeTable({ data: [], error: null }),
      uptime_checks: fakeTable({
        data: [
          { url: "https://internal.zapnivo.com/", ok: true, status_code: 307, checked_at: T3 },
          { url: "https://internal.zapnivo.com/admin", ok: false, status_code: 200, checked_at: T3 },
        ],
        error: null,
      }),
    });
    const s = await getAppHealthSummary(db);
    const internal = s.apps.find((a) => a.app === "internal")!;
    expect(internal.state).toBe("degraded");
    expect(internal.criticalFailures).toBeNull();
    expect(internal.note).toMatch(/criticality unknown/);
  });

  it("unreachable profile verdict maps through", async () => {
    const db = fakeDb({
      system_audit_events: fakeTable({
        data: [auditRow("system", { health_status: "unreachable", checks_ok: 0, checks_total: 3, critical_failures: ["console_wall"] })],
        error: null,
      }),
      uptime_checks: fakeTable({ data: [], error: null }),
    });
    const s = await getAppHealthSummary(db);
    const sys = s.apps.find((a) => a.app === "system")!;
    expect(sys.state).toBe("unreachable");
    expect(sys.criticalFailures).toBe(1);
  });
});
