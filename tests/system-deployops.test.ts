import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createDeploymentRequest, decideDeploymentRequest, executeDeploymentRequest,
  isDeployAction, type DeploymentRequestRow,
} from "@/lib/system/deployops";

/* ── Minimal Supabase stub ─────────────────────────────────────────────── */

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
const approver = { id: "apr-2", role: "security" };
const executor = { id: "exe-3", role: "sysadmin" };

const row = (over: Partial<DeploymentRequestRow> = {}): DeploymentRequestRow => ({
  id: "d-1", action: "deploy", target_env: "production",
  justification: "ship v1.4.2 to production", status: "pending",
  requested_by: "req-1", decided_by: null, decided_at: null, result: null,
  created_at: new Date().toISOString(), ...over,
});

describe("deployment request workflow", () => {
  it("validates action + justification", async () => {
    expect(isDeployAction("deploy")).toBe(true);
    expect(isDeployAction("nuke")).toBe(false);
    const db = fakeDb({});
    const bad = await createDeploymentRequest(db, requester, { action: "deploy", justification: "short" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(400);
    const badAction = await createDeploymentRequest(db, requester, { action: "nuke" as never, justification: "a long enough justification" });
    expect(badAction.ok).toBe(false);
  });

  it("creates a PENDING request and audits it", async () => {
    const reqs = fakeTable({ singles: [{ data: row(), error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: audit });
    const res = await createDeploymentRequest(db, requester, { action: "deploy", targetEnv: "production", justification: "ship v1.4.2 to production" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.request.status).toBe("pending");
    const ins = callsOf(reqs).inserted[0] as Record<string, unknown>;
    expect(ins.status).toBe("pending");
    expect(ins.requested_by).toBe("req-1");
    expect(callsOf(audit).inserted[0]).toMatchObject({ action: "deployment.requested" });
  });

  it("BLOCKS self-approval (separation of duties)", async () => {
    const reqs = fakeTable({ singles: [{ data: row({ status: "pending", requested_by: "req-1" }), error: null }] });
    const db = fakeDb({ system_deployment_requests: reqs });
    const res = await decideDeploymentRequest(db, requester, "d-1", "approved");
    expect(res.ok).toBe(false);
    if (!res.ok) { expect(res.status).toBe(403); expect(res.error).toMatch(/separation of duties/i); }
    expect(callsOf(reqs).updated).toHaveLength(0);
  });

  it("approves when decider differs from requester", async () => {
    const reqs = fakeTable({
      singles: [
        { data: row({ status: "pending", requested_by: "req-1" }), error: null },
        { data: row({ status: "approved", requested_by: "req-1", decided_by: "apr-2" }), error: null },
      ],
    });
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: fakeTable() });
    const res = await decideDeploymentRequest(db, approver, "d-1", "approved", "lgtm");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.request.status).toBe("approved");
    const upd = callsOf(reqs).updated[0] as Record<string, unknown>;
    expect(upd.status).toBe("approved");
    expect(upd.decided_by).toBe("apr-2");
  });

  it("rejects decisions on non-pending requests", async () => {
    const reqs = fakeTable({ singles: [{ data: row({ status: "approved", requested_by: "req-1", decided_by: "apr-2" }), error: null }] });
    const db = fakeDb({ system_deployment_requests: reqs });
    const res = await decideDeploymentRequest(db, approver, "d-1", "rejected");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("execute returns awaiting_manual_deploy and never calls a provider", async () => {
    const reqs = fakeTable({
      singles: [{ data: row({ status: "approved", requested_by: "req-1", decided_by: "apr-2" }), error: null }],
      select: { data: [], error: null },
    });
    const audit = fakeTable();
    const db = fakeDb({ system_deployment_requests: reqs, system_audit_events: audit });
    const res = await executeDeploymentRequest(db, executor, "d-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.status).toBe("awaiting_manual_deploy");
      expect(res.result.reason).toMatch(/git push|Vercel dashboard/i);
      expect(typeof res.result.providerTokenPresent).toBe("boolean");
    }
    // an update recorded the attempt, but status stays 'approved' (manual deploy pending)
    const upd = callsOf(reqs).updated[0] as { result?: { last_execute_attempt?: { status?: string } } };
    expect(upd.result?.last_execute_attempt?.status).toBe("awaiting_manual_deploy");
    expect(callsOf(audit).inserted[0]).toMatchObject({ action: "deployment.execute_attempted" });
  });

  it("execute refuses non-approved requests and self-execution", async () => {
    const pending = fakeTable({ singles: [{ data: row({ status: "pending" }), error: null }] });
    const db1 = fakeDb({ system_deployment_requests: pending });
    const r1 = await executeDeploymentRequest(db1, executor, "d-1");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.status).toBe(409);

    const approved = fakeTable({ singles: [{ data: row({ status: "approved", requested_by: "req-1", decided_by: "apr-2" }), error: null }] });
    const db2 = fakeDb({ system_deployment_requests: approved });
    const r2 = await executeDeploymentRequest(db2, requester, "d-1"); // requester tries to execute own request
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.status).toBe(403);
  });
});
