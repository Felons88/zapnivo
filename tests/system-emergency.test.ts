import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EMERGENCY_OPS,
  EMERGENCY_PAUSABLE_FLAGS,
  executeEmergencyOp,
  getMaintenanceNotice,
  listEmergencyActions,
  type EmergencyInput,
} from "@/lib/system/emergency";
import type { SessionUser } from "@/lib/auth";

/* ── Minimal Supabase stub (same pattern as tests/system-elevation.test.ts) ── */
type Result = { data?: unknown; error?: { message: string } | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown; _upsert?: unknown } = {};
  const next = (): Result => (singles.length ? singles.shift()! : { data: null, error: null });
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "insert", "update", "upsert", "delete", "filter", "like", "gte", "lt"]) {
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
    Promise.resolve(opts.list ?? { data: [], error: null }).then(res, rej);
  return b;
}
function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  const calls: string[] = [];
  const db = {
    from: (t: string) => {
      calls.push(t);
      return tables[t] ?? fakeTable();
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const user = (id = "op-1"): SessionUser => ({ id, email: "op@zapnivo.com", role: "staff", organizationId: null });
const actor = { id: "op-1", role: "sysadmin" };

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const elevRow = () => ({
  id: "e1", profile_id: "op-1", method: "totp",
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  consumed_action: null, created_ip: null,
});
const dbWithElevation = (extra: Record<string, ReturnType<typeof fakeTable>> = {}) =>
  fakeDb({ system_elevations: fakeTable({ list: { data: [elevRow()] } }), ...extra });

const base = (over: Partial<EmergencyInput>): EmergencyInput => ({
  op: "disable_ai_agent",
  confirm: "disable_ai_agent",
  reason: "incident INC-1234 — agent misbehaving in prod",
  ...over,
});

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: "support.qa", name: "Support QA", description: null, department: "support",
  model: "openai/gpt-4o-mini", temperature: 0.2, max_tokens: 1024, timeout_ms: 30000,
  permissions: ["analytics.aggregate.read"], tools: [], enabled: true,
  daily_budget_cents: 0, monthly_budget_cents: 0, max_calls_per_hour: 60,
  escalation_policy: null, config: {}, created_at: "", updated_at: "",
  ...over,
});

describe("emergency op surface", () => {
  it("exposes exactly five scoped ops — no global kill switch exists", () => {
    expect(EMERGENCY_OPS).toEqual([
      "suspend_device_credential",
      "quarantine_device",
      "pause_integration_feature",
      "disable_ai_agent",
      "maintenance_banner",
    ]);
    // No op can target "all" agents/devices/flags — every op names one target.
    for (const op of EMERGENCY_OPS) {
      expect(op).not.toMatch(/all|global|everything|bulk/i);
    }
    expect(EMERGENCY_PAUSABLE_FLAGS).not.toContain("stripe");
    expect(EMERGENCY_PAUSABLE_FLAGS).not.toContain("auth");
    expect(EMERGENCY_PAUSABLE_FLAGS).not.toContain("session");
    expect(EMERGENCY_PAUSABLE_FLAGS).not.toContain("secrets");
  });

  it("pausable flag whitelist contains only noncritical AI flags", () => {
    expect([...EMERGENCY_PAUSABLE_FLAGS].sort()).toEqual(["ai_account_tools", "receptionist_autosend"]);
  });
});

describe("executeEmergencyOp gates", () => {
  it("503 without a backend", async () => {
    const res = await executeEmergencyOp(null, user(), actor, base({}));
    expect(res).toMatchObject({ ok: false, status: 503 });
  });

  it("400 on unknown op, mismatched confirm, and short reason", async () => {
    const { db } = dbWithElevation();
    expect(await executeEmergencyOp(db, user(), actor, base({ op: "nuke_everything" as never })))
      .toMatchObject({ ok: false, status: 400 });
    expect(await executeEmergencyOp(db, user(), actor, base({ confirm: "yes" })))
      .toMatchObject({ ok: false, status: 400, code: "confirm_required" });
    expect(await executeEmergencyOp(db, user(), actor, base({ reason: "short" })))
      .toMatchObject({ ok: false, status: 400, code: "reason_required" });
  });

  it("403 step_up_required for EVERY op without a live elevation", async () => {
    const { db } = fakeDb({ system_elevations: fakeTable({ list: { data: [] } }) });
    const ops: EmergencyInput[] = [
      base({ op: "suspend_device_credential", confirm: "suspend_device_credential", device_id: DEVICE_ID }),
      base({ op: "quarantine_device", confirm: "quarantine_device", device_id: DEVICE_ID }),
      base({ op: "pause_integration_feature", confirm: "pause_integration_feature", flag: "receptionist_autosend" }),
      base({}),
      base({ op: "maintenance_banner", confirm: "maintenance_banner", banner_enabled: false }),
    ];
    for (const input of ops) {
      const res = await executeEmergencyOp(db, user(), actor, input);
      expect(res, input.op).toMatchObject({ ok: false, status: 403, code: "step_up_required" });
    }
    expect(await executeEmergencyOp(db, null, actor, base({}))).toMatchObject({ ok: false, status: 401 });
  });
});

describe("executeEmergencyOp — disable_ai_agent", () => {
  const aiTables = () => ({
    ai_agents: fakeTable({
      singles: [
        { data: agentRow(), error: null }, // getAgent in opDisableAgent
        { data: agentRow(), error: null }, // getAgent inside setAgentKillState
        { data: agentRow({ enabled: false, config: { kill_reason: "x" } }), error: null }, // updateAgent select
      ],
    }),
    system_audit_events: fakeTable(),
  });

  it("disables one agent via updateAgent and writes audit events", async () => {
    const { db } = dbWithElevation(aiTables());
    const res = await executeEmergencyOp(db, user(), actor, base({ agent_id: "support.qa" }));
    expect(res).toMatchObject({ ok: true, op: "disable_ai_agent" });
    if (res.ok) expect(res.summary).toContain("support.qa");
  });

  it("409-path: already-disabled agent returns ok with honest summary", async () => {
    const tables = aiTables();
    // Replace singles: first getAgent returns disabled agent.
    tables.ai_agents = fakeTable({ singles: [{ data: agentRow({ enabled: false }), error: null }] });
    const { db } = dbWithElevation(tables);
    const res = await executeEmergencyOp(db, user(), actor, base({ agent_id: "support.qa" }));
    expect(res).toMatchObject({ ok: true, summary: expect.stringContaining("already disabled") });
  });

  it("404 on unknown agent", async () => {
    const { db } = dbWithElevation({ ai_agents: fakeTable({ singles: [{ data: null, error: null }] }) });
    const res = await executeEmergencyOp(db, user(), actor, base({ agent_id: "nope.agent" }));
    expect(res).toMatchObject({ ok: false, status: 404 });
  });
});

describe("executeEmergencyOp — pause_integration_feature", () => {
  it("400 flag_not_allowed for non-whitelisted flags (checked before any mutation)", async () => {
    const { db } = dbWithElevation();
    const res = await executeEmergencyOp(db, user(), actor, base({
      op: "pause_integration_feature", confirm: "pause_integration_feature", flag: "gift_sales",
    }));
    expect(res).toMatchObject({ ok: false, status: 400, code: "flag_not_allowed" });
  });

  it("404 when the whitelisted flag row does not exist", async () => {
    const flags = fakeTable({ singles: [{ data: null, error: null }] });
    const { db } = dbWithElevation({ system_feature_flags: flags });
    const res = await executeEmergencyOp(db, user(), actor, base({
      op: "pause_integration_feature", confirm: "pause_integration_feature", flag: "receptionist_autosend",
    }));
    expect(res).toMatchObject({ ok: false, status: 404 });
  });

  it("disables an existing whitelisted flag via setFeatureFlag", async () => {
    const flags = fakeTable({
      singles: [
        { data: { key: "receptionist_autosend", enabled: true }, error: null }, // emergency pre-check
        { data: { description: "d", owner: "ai", prerequisites: [] }, error: null }, // setFeatureFlag prior
        { data: { key: "receptionist_autosend", enabled: false }, error: null }, // upsert select
      ],
    });
    const { db } = dbWithElevation({ system_feature_flags: flags });
    const res = await executeEmergencyOp(db, user(), actor, base({
      op: "pause_integration_feature", confirm: "pause_integration_feature", flag: "receptionist_autosend",
    }));
    expect(res).toMatchObject({ ok: true, op: "pause_integration_feature" });
    expect((flags._upsert as Record<string, unknown>).enabled).toBe(false);
  });
});

describe("executeEmergencyOp — device ops", () => {
  const deviceRow = (over: Record<string, unknown> = {}) => ({
    id: DEVICE_ID, device_uid: "kiosk-abc123", serial_number: "SN-1", status: "active",
    auth_method: "hmac_sha256", device_secret_hash: "abc123", device_secret_enc: null,
    device_secret_enc_next: null, credential_next_expires_at: null, credential_rotated_at: null,
    credential_issued_at: "2026-01-01T00:00:00Z", credential_expires_at: "2027-01-01T00:00:00Z",
    credential_revoked_at: null, last_authed_at: null, last_message_ts: null,
    ...over,
  });

  it("suspend_device_credential revokes the credential (high risk → needs approved CR)", async () => {
    // No approved change request → 202 pending, credential untouched.
    const devices = fakeTable({ singles: [{ data: deviceRow(), error: null }] });
    const changes = fakeTable({
      list: { data: [] },
      singles: [{ data: { id: "cr-1" }, error: null }],
    });
    const { db } = dbWithElevation({ system_devices: devices, system_change_requests: changes });
    const res = await executeEmergencyOp(db, user(), actor, base({
      op: "suspend_device_credential", confirm: "suspend_device_credential", device_id: DEVICE_ID,
    }));
    expect(res).toMatchObject({ ok: false, status: 202, pending: true, changeRequestId: "cr-1" });
  });

  it("suspend_device_credential executes with an approved change request", async () => {
    const devices = fakeTable({
      singles: [
        { data: deviceRow(), error: null }, // getDeviceAuthRow
        { data: deviceRow({ auth_method: "none", credential_revoked_at: "2026-02-01T00:00:00Z" }), error: null }, // revoke update select
      ],
    });
    const changes = fakeTable({
      list: { data: [{ id: "cr-9", decided_by: "someone-else" }] }, // hasApprovedChange → approved
    });
    const { db } = dbWithElevation({ system_devices: devices, system_change_requests: changes });
    const res = await executeEmergencyOp(db, user(), actor, base({
      op: "suspend_device_credential", confirm: "suspend_device_credential", device_id: DEVICE_ID,
    }));
    expect(res).toMatchObject({ ok: true, op: "suspend_device_credential", changeRequestId: "cr-9" });
    const upd = devices._update as Record<string, unknown>;
    expect(upd.auth_method).toBe("none");
    expect(upd.device_secret_enc).toBeNull();
    expect(upd.device_secret_hash).toBeNull();
  });

  it("quarantine_device moves active → quarantined and audits kiosk.status_changed", async () => {
    const devices = fakeTable({ singles: [{ data: deviceRow({ status: "active" }), error: null }] });
    const changes = fakeTable({ list: { data: [{ id: "cr-q", decided_by: "other-actor" }] } });
    const audits = fakeTable();
    const { db } = dbWithElevation({ system_devices: devices, system_change_requests: changes, system_audit_events: audits });
    const res = await executeEmergencyOp(db, user(), actor, base({
      op: "quarantine_device", confirm: "quarantine_device", device_id: DEVICE_ID,
    }));
    expect(res).toMatchObject({ ok: true, op: "quarantine_device" });
    const upd = devices._update as Record<string, unknown>;
    expect(upd.status).toBe("quarantined");
  });

  it("quarantine_device refuses illegal transitions (decommissioned, pending)", async () => {
    for (const status of ["decommissioned", "pending", "quarantined"]) {
      const devices = fakeTable({ singles: [{ data: deviceRow({ status }), error: null }] });
      const { db } = dbWithElevation({ system_devices: devices });
      const res = await executeEmergencyOp(db, user(), actor, base({
        op: "quarantine_device", confirm: "quarantine_device", device_id: DEVICE_ID,
      }));
      expect(res.ok, status).toBe(false);
      expect((res as { status: number }).status).toBe(409);
    }
  });
});

describe("executeEmergencyOp — maintenance_banner", () => {
  it("sets the flag with a TTL payload and clears it", async () => {
    const flags = fakeTable();
    const { db } = dbWithElevation({ system_feature_flags: flags });
    const res = await executeEmergencyOp(db, user(), actor, base({
      op: "maintenance_banner", confirm: "maintenance_banner",
      banner_enabled: true, banner_message: "Scheduled maintenance 02:00–04:00 UTC", banner_minutes: 120,
    }));
    expect(res).toMatchObject({ ok: true, op: "maintenance_banner" });
    expect(res.ok && res.expiresAt).toBeTruthy();
    const up = flags._upsert as Record<string, unknown>;
    expect(up.key).toBe("maintenance.notice");
    expect(up.enabled).toBe(true);
    const prereq = up.prerequisites as { expires_at: string; message: string };
    expect(Date.parse(prereq.expires_at)).toBeGreaterThan(Date.now());
    expect(prereq.message).toContain("Scheduled maintenance");

    // Clear path.
    const res2 = await executeEmergencyOp(db, user(), actor, base({
      op: "maintenance_banner", confirm: "maintenance_banner", banner_enabled: false,
    }));
    expect(res2).toMatchObject({ ok: true });
    expect((flags._upsert as Record<string, unknown>).enabled).toBe(false);
  });

  it("rejects a banner message that is too short", async () => {
    const { db } = dbWithElevation({ system_feature_flags: fakeTable() });
    const res = await executeEmergencyOp(db, user(), actor, base({
      op: "maintenance_banner", confirm: "maintenance_banner",
      banner_enabled: true, banner_message: "short",
    }));
    expect(res).toMatchObject({ ok: false, status: 400 });
  });
});

describe("getMaintenanceNotice / listEmergencyActions", () => {
  it("returns the notice only while enabled and unexpired", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const flags = fakeTable({ singles: [{ data: { enabled: true, prerequisites: { expires_at: future, message: "Down for upgrades" } }, error: null }] });
    const { db } = fakeDb({ system_feature_flags: flags });
    expect(await getMaintenanceNotice(db)).toEqual({ message: "Down for upgrades", expiresAt: future });

    const expired = fakeTable({ singles: [{ data: { enabled: true, prerequisites: { expires_at: "2020-01-01T00:00:00Z", message: "old" } }, error: null }] });
    const { db: d2 } = fakeDb({ system_feature_flags: expired });
    expect(await getMaintenanceNotice(d2)).toBeNull();
    expect(await getMaintenanceNotice(null)).toBeNull();
  });

  it("lists emergency.* audit rows only", async () => {
    const audits = fakeTable({
      list: { data: [{ id: "a1", actor_id: "op-1", actor_role: "sysadmin", action: "emergency.disable_ai_agent", resource: "emergency:disable_ai_agent:x", detail: { op: "disable_ai_agent" }, created_at: "2026-02-01T00:00:00Z" }] },
    });
    const { db } = fakeDb({ system_audit_events: audits });
    const rows = await listEmergencyActions(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("emergency.disable_ai_agent");
    expect(await listEmergencyActions(null)).toEqual([]);
  });
});
