import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertApprovedOrRequest, decideChange, requestChange, systemAudit,
  type ChangeRequestRow,
} from "@/lib/system/audit";
import { setFeatureFlag } from "@/lib/system/flags";
import { requireSystem } from "@/lib/system/rbac";
import type { SessionUser } from "@/lib/auth";

const actor = (id: string, role = "sysadmin") => ({ id, role });
const user = (id: string): SessionUser => ({ id, email: `${id}@zapnivo.com`, role: "staff", organizationId: null });

/* ── Minimal Supabase stub ─────────────────────────────────────────────── */

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown; _upsert?: unknown } = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "insert", "update", "upsert", "delete", "filter"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "insert") b._insert = a[0];
      if (m === "update") b._update = a[0];
      if (m === "upsert") b._upsert = a[0];
      return b;
    };
  }
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(opts.list ?? { data: [], error: null, count: 0 }).then(res, rej);
  return b;
}
function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}
const pendingCr = (over: Partial<ChangeRequestRow> = {}): ChangeRequestRow => ({
  id: "cr-1", action: "deploy.api", environment: "production", risk: "high",
  justification: "rotate keys", status: "pending", requested_by: "req-1",
  decided_by: null, decided_at: null, result: null, created_at: new Date().toISOString(), ...over,
});

describe("systemAudit", () => {
  it("writes an audit row and never throws", async () => {
    const auditTable = fakeTable();
    const db = fakeDb({ system_audit_events: auditTable });
    await systemAudit(db, { actor: actor("u-1", "sysadmin"), action: "flag.enabled", resource: "feature_flag:x", detail: { flag: "x", api_key: "should-be-dropped" } });
    const row = auditTable._insert as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.actor_id).toBe("u-1");
    expect(row.actor_role).toBe("sysadmin");
    expect(row.action).toBe("flag.enabled");
    expect(row.resource).toBe("feature_flag:x");
    expect((row.detail as Record<string, unknown>).api_key).toBeUndefined();
    expect((row.detail as Record<string, unknown>).flag).toBe("x");
  });

  it("tolerates a null db (unconfigured backend)", async () => {
    await expect(systemAudit(null, { actor: null, action: "x.y", resource: "r" })).resolves.toBeUndefined();
  });
});

describe("requestChange", () => {
  it("inserts a pending change request and audits it", async () => {
    const crTable = fakeTable({ singles: [{ data: { id: "cr-new" }, error: null }] });
    const db = fakeDb({ system_change_requests: crTable });
    const res = await requestChange(db, actor("req-1", "breakglass"), { action: "deploy.api", risk: "critical", justification: "needs approval" });
    expect(res.id).toBe("cr-new");
    const row = crTable._insert as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.requested_by).toBe("req-1");
    expect(row.risk).toBe("critical");
  });
});

describe("assertApprovedOrRequest (breakglass + high-risk gate)", () => {
  it("breakglass with no approved change → creates pending request, does not proceed", async () => {
    const crTable = fakeTable({
      list: { data: [], error: null },                                   // hasApprovedChange → none
      singles: [{ data: { id: "cr-pending" }, error: null }],            // requestChange insert
    });
    const db = fakeDb({ system_change_requests: crTable });
    const res = await assertApprovedOrRequest(db, actor("bg-1", "breakglass"), { action: "flag.enable:x", risk: "medium", justification: "toggle" });
    expect(res.status).toBe("pending");
    if (res.status === "pending") expect(res.changeRequestId).toBe("cr-pending");
  });

  it("breakglass WITH an approved change decided by someone else → proceeds", async () => {
    const crTable = fakeTable({
      list: { data: [{ id: "cr-ok", decided_by: "decider-2" }], error: null },
    });
    const db = fakeDb({ system_change_requests: crTable });
    const res = await assertApprovedOrRequest(db, actor("bg-1", "breakglass"), { action: "flag.enable:x", risk: "medium", justification: "toggle" });
    expect(res).toEqual({ status: "approved", changeRequestId: "cr-ok" });
  });

  it("self-decided approval does NOT satisfy separation of duties", async () => {
    const crTable = fakeTable({
      list: { data: [{ id: "cr-self", decided_by: "bg-1" }], error: null }, // decided_by === requester
      singles: [{ data: { id: "cr-pending2" }, error: null }],
    });
    const db = fakeDb({ system_change_requests: crTable });
    const res = await assertApprovedOrRequest(db, actor("bg-1", "breakglass"), { action: "flag.enable:x", risk: "medium", justification: "toggle" });
    expect(res.status).toBe("pending");
  });

  it("high-risk mutation by a normal role also requires approval", async () => {
    const crTable = fakeTable({
      list: { data: [], error: null },
      singles: [{ data: { id: "cr-risk" }, error: null }],
    });
    const db = fakeDb({ system_change_requests: crTable });
    const res = await assertApprovedOrRequest(db, actor("eng-1", "engineer"), { action: "db.migrate", risk: "high", justification: "schema change" });
    expect(res.status).toBe("pending");
  });

  it("low-risk mutation by a normal role proceeds without a change request", async () => {
    const db = fakeDb({});
    const res = await assertApprovedOrRequest(db, actor("eng-1", "engineer"), { action: "flag.enable:x", risk: "low", justification: "toggle" });
    expect(res).toEqual({ status: "approved", changeRequestId: null });
  });
});

describe("decideChange (separation of duties)", () => {
  it("rejects self-approval", async () => {
    const crTable = fakeTable({ singles: [{ data: pendingCr({ requested_by: "me-1" }), error: null }] });
    const db = fakeDb({ system_change_requests: crTable });
    const res = await decideChange(db, actor("me-1", "security"), "cr-1", "approved");
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect((res as { error: string }).error).toMatch(/separation of duties/i);
  });

  it("rejects decisions on non-pending requests", async () => {
    const crTable = fakeTable({ singles: [{ data: pendingCr({ status: "approved" }), error: null }] });
    const db = fakeDb({ system_change_requests: crTable });
    const res = await decideChange(db, actor("dec-1", "security"), "cr-1", "rejected");
    expect(res).toMatchObject({ ok: false, status: 409 });
  });

  it("allows a different decider and audits the decision", async () => {
    const updated = pendingCr({ status: "approved", decided_by: "dec-1" });
    const crTable = fakeTable({ singles: [{ data: pendingCr(), error: null }, { data: updated, error: null }] });
    const auditTable = fakeTable();
    const db = fakeDb({ system_change_requests: crTable, system_audit_events: auditTable });
    const res = await decideChange(db, actor("dec-1", "security"), "cr-1", "approved", "looks good");
    expect(res.ok).toBe(true);
    const upd = crTable._update as Record<string, unknown>;
    expect(upd.status).toBe("approved");
    expect(upd.decided_by).toBe("dec-1");
    const auditRow = auditTable._insert as Record<string, unknown>;
    expect(auditRow.action).toBe("change.approved");
  });

  it("404s on missing change requests", async () => {
    const db = fakeDb({ system_change_requests: fakeTable({ singles: [{ data: null, error: null }] }) });
    const res = await decideChange(db, actor("dec-1", "sysadmin"), "cr-x", "approved");
    expect(res).toMatchObject({ ok: false, status: 404 });
  });
});

describe("setFeatureFlag", () => {
  it("upserts the flag row and writes an audit event", async () => {
    const flagTable = fakeTable({ singles: [{ data: null, error: null }, { data: { key: "gift_sales", enabled: true, environment: "production" }, error: null }] });
    const auditTable = fakeTable();
    const db = fakeDb({ system_feature_flags: flagTable, system_audit_events: auditTable });
    const res = await setFeatureFlag(db, actor("eng-1", "engineer"), { key: "gift_sales", enabled: true });
    expect(res.ok).toBe(true);
    const up = flagTable._upsert as Record<string, unknown>;
    expect(up.enabled).toBe(true);
    expect(up.updated_by).toBe("eng-1");
    const auditRow = auditTable._insert as Record<string, unknown>;
    expect(auditRow.action).toBe("flag.enabled");
    expect(auditRow.resource).toBe("feature_flag:gift_sales");
  });

  it("rejects malformed keys", async () => {
    const db = fakeDb({});
    const res = await setFeatureFlag(db, actor("eng-1", "engineer"), { key: "BAD KEY!", enabled: true });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });
});

describe("unauthenticated access", () => {
  it("requireSystem returns 401 without a session", async () => {
    const db = fakeDb({});
    const r = await requireSystem("system.dashboard.view", { user: null, db });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });
});
