import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  blockedAdapter, ADAPTER_NOT_CONFIGURED, NO_GATEWAY_CAPABILITIES, NO_UPDATE_CAPABILITIES,
  getGatewayAdapter, isGatewayUpdateCapable, updateCapabilitiesOf,
  __unregisterGatewayAdapterForTests,
  type GatewayAdapter,
} from "@/lib/kiosk/gateway-adapter";
import {
  configRevisionToTargetState, dispatchConfigRollout, proposeConfigRollout,
  refreshConfigRolloutTargets,
} from "@/lib/system/update-config";
import type { SystemDeviceRow } from "@/lib/system/kiosks";

/**
 * Phase 4.3 — gateway update-delivery surface + config rollout bridge.
 * In-memory Supabase stub — same philosophy as system-device-config.test.ts.
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    neq(c: string, v: unknown) { this.filters.push((r) => !eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const out: Row[] = [];
        for (const item of items) {
          const row: Row = { ...item };
          if (row.id == null) row.id = crypto.randomUUID();
          rows.push(row); out.push(row);
        }
        return { data: out, error: null };
      }
      if (this.op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return { data: affected, error: null };
      }
      let out = rows.filter(match);
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : -cmp(a[col], b[col])));
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    private finish() { return this.run(); }
    single() {
      const { data } = this.finish();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    }
    maybeSingle() {
      const { data } = this.finish();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.finish()).then(onF, onR);
    }
  }
  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const ACTOR = { id: "op-1", role: "sysadmin" };
const BREAKGLASS = { id: "bg-1", role: "breakglass" };
const DEV1 = { id: "11111111-1111-4111-8111-111111111111", device_uid: "DEV-001", status: "active" } as unknown as SystemDeviceRow;
const DEV2 = { id: "22222222-2222-4222-8222-222222222222", device_uid: "DEV-002", status: "active" } as unknown as SystemDeviceRow;

const RELEASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMPAIGN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const baseSeed = () => ({
  system_devices: [
    { id: DEV1.id, device_uid: "DEV-001", status: "active" },
    { id: DEV2.id, device_uid: "DEV-002", status: "active" },
  ],
  device_config_revisions: [] as Row[],
  system_device_commands: [] as Row[],
  system_audit_events: [] as Row[],
  system_change_requests: [] as Row[],
  kiosk_update_releases: [] as Row[],
  kiosk_update_campaigns: [] as Row[],
  kiosk_update_targets: [] as Row[],
});

const ENV = "KIOSK_ADAPTER";
const savedEnv = process.env[ENV];
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
  __unregisterGatewayAdapterForTests("test-gw");
});

/* ── 1. Update-delivery capability surface ────────────────────────────────── */

describe("GatewayUpdateCapable surface", () => {
  it("blockedAdapter reports all update capabilities false and fails every update op unsupported_capability", async () => {
    const a = blockedAdapter(ADAPTER_NOT_CONFIGURED);
    expect(a.updateCapabilities()).toEqual(NO_UPDATE_CAPABILITIES);
    expect(Object.values(a.updateCapabilities()).every((c) => c === false)).toBe(true);
    const ref = { deviceId: "d", commandId: "c" };
    const results = await Promise.all([
      a.deliverFirmwareArtifact({ ...ref, targetVersion: "1.0", artifact: { deviceId: "d", commandId: "c", version: "1.0", artifactRef: "x", sha256: "s", signature: "g" } }),
      a.pushConfigUpdate({ ...ref, desired: { brightness: 50 } }),
      a.queryUpdateStatus(ref),
      a.reportInstalledVersion({ deviceId: "d" }),
      a.verifyReconnect(ref),
      a.requestRollback({ ...ref, rollbackRef: "rb", sha256: "s", signature: "g" }),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("unsupported_capability");
    }
  });

  it("getGatewayAdapter() with KIOSK_ADAPTER unset yields all-false update capabilities", () => {
    delete process.env[ENV];
    const a = getGatewayAdapter();
    expect(isGatewayUpdateCapable(a)).toBe(true); // blocked impl satisfies the interface honestly
    expect(updateCapabilitiesOf(a)).toEqual(NO_UPDATE_CAPABILITIES);
  });

  it("a base-only GatewayAdapter is NOT update-capable and reports all-false", () => {
    const baseOnly: GatewayAdapter = {
      name: "base-only",
      capabilities: () => ({ ...NO_GATEWAY_CAPABILITIES }),
      authenticate: async () => ({ ok: false, error: { code: "adapter_error", detail: "x" } }),
      ingestHeartbeat: async () => ({ ok: true, data: { accepted: 0 } }),
      ingestInventory: async () => ({ ok: true, data: { accepted: 0 } }),
      dispatchCommand: async () => ({ ok: false, error: { code: "adapter_error", detail: "x" } }),
      commandStatus: async () => ({ ok: true, data: null }),
      dispense: async () => ({ ok: true, data: { status: "failed", reason: "unsupported" } }),
      reportReturn: async () => ({ ok: true, data: { status: "rejected", reason: "empty_slot" } }),
      updateConfig: async () => ({ ok: false, error: { code: "unsupported_capability", detail: "x" } }),
      updateFirmware: async () => ({ ok: false, error: { code: "unsupported_capability", detail: "x" } }),
      diagnostics: async () => ({ ok: true, data: { checkedAt: "", adapter: "b", checks: [] } }),
      reconcile: async () => ({ ok: true, data: { applied: 0, duplicates: 0 } }),
    };
    expect(isGatewayUpdateCapable(baseOnly)).toBe(false);
    expect(updateCapabilitiesOf(baseOnly)).toEqual(NO_UPDATE_CAPABILITIES);
  });
});

/* ── 2. proposeConfigRollout validation ───────────────────────────────────── */

describe("proposeConfigRollout", () => {
  it("rejects invalid device ids and missing/invalid config payload", async () => {
    const { db } = fakeDb(baseSeed());
    const bad = await proposeConfigRollout(db, ACTOR, { deviceIds: ["not-a-uuid"], configPayload: { brightness: 50 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(400);
    const noConfig = await proposeConfigRollout(db, ACTOR, { deviceIds: [DEV1.id], configPayload: { bogus_key: 1 } });
    expect(noConfig.ok).toBe(false);
    if (!noConfig.ok) expect(noConfig.status).toBe(400);
    const empty = await proposeConfigRollout(db, ACTOR, { deviceIds: [DEV1.id], configPayload: {} });
    expect(empty.ok).toBe(false);
  });

  it("rejects non-config or unapproved releases", async () => {
    const { db } = fakeDb({
      ...baseSeed(),
      kiosk_update_releases: [
        { id: RELEASE_ID, kind: "firmware", version: "1.0", channel: "stable", status: "approved", signature_status: "verified" },
        { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: "config", version: "cfg-1", channel: "stable", status: "draft", signature_status: "unsigned" },
      ],
    });
    const wrongKind = await proposeConfigRollout(db, ACTOR, { releaseId: RELEASE_ID, deviceIds: [DEV1.id], configPayload: { brightness: 50 } });
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.status).toBe(400);
    const draft = await proposeConfigRollout(db, ACTOR, { releaseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", deviceIds: [DEV1.id], configPayload: { brightness: 50 } });
    expect(draft.ok).toBe(false);
    if (!draft.ok) expect(draft.status).toBe(409);
  });

  it("standalone rollout creates approved revisions and NO update targets", async () => {
    const { db, tables } = fakeDb(baseSeed());
    const r = await proposeConfigRollout(db, ACTOR, {
      deviceIds: [DEV1.id, DEV2.id], configPayload: { brightness: 75 }, justification: "fleet brightness",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("standalone");
    expect(r.summary.approved).toBe(2);
    expect(tables.device_config_revisions).toHaveLength(2);
    for (const rev of tables.device_config_revisions) expect(rev.status).toBe("approved");
    expect(tables.kiosk_update_targets).toHaveLength(0); // campaign_id NOT NULL — no campaign, no targets
  });

  it("campaign-linked rollout queues kiosk_update_targets bound to revisions", async () => {
    const { db, tables } = fakeDb({
      ...baseSeed(),
      kiosk_update_releases: [
        { id: RELEASE_ID, kind: "config", version: "cfg-2", channel: "stable", status: "approved", signature_status: "unsigned" },
      ],
      kiosk_update_campaigns: [
        { id: CAMPAIGN_ID, release_id: RELEASE_ID, name: "Q1 brightness", status: "approved", target_filter: {} },
      ],
    });
    const r = await proposeConfigRollout(db, ACTOR, {
      releaseId: RELEASE_ID, deviceIds: [DEV1.id], configPayload: { brightness: 60 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("campaign");
    expect(r.campaign?.id).toBe(CAMPAIGN_ID);
    expect(tables.kiosk_update_targets).toHaveLength(1);
    const t = tables.kiosk_update_targets[0];
    expect(t.state).toBe("queued");
    expect((t.result as Row).config_revision_id).toBe(r.devices[0].revisionId);
    expect((t.result as Row).release_id).toBe(RELEASE_ID);
  });

  it("breakglass actor gets pending change requests — no approved revision, no target", async () => {
    const { db, tables } = fakeDb({
      ...baseSeed(),
      kiosk_update_releases: [
        { id: RELEASE_ID, kind: "config", version: "cfg-2", channel: "stable", status: "approved", signature_status: "unsigned" },
      ],
      kiosk_update_campaigns: [
        { id: CAMPAIGN_ID, release_id: RELEASE_ID, name: "camp", status: "approved", target_filter: {} },
      ],
    });
    const r = await proposeConfigRollout(db, BREAKGLASS, {
      releaseId: RELEASE_ID, deviceIds: [DEV1.id], configPayload: { maintenance_mode: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.devices[0].pending).toBe(true);
    expect(r.devices[0].targetId).toBeUndefined();
    expect(tables.kiosk_update_targets).toHaveLength(0);
    expect(tables.device_config_revisions[0].status).toBe("draft");
    expect(tables.system_change_requests.length).toBeGreaterThan(0);
  });
});

/* ── 3. dispatchConfigRollout — adapter honesty ───────────────────────────── */

describe("dispatchConfigRollout", () => {
  it("KIOSK_ADAPTER unset → honest adapter_disabled failures, never fake success", async () => {
    delete process.env[ENV];
    const { db, tables } = fakeDb(baseSeed());
    // Pre-seed an approved revision per device.
    await proposeConfigRollout(db, ACTOR, { deviceIds: [DEV1.id], configPayload: { brightness: 50 } });
    const r = await dispatchConfigRollout(db, ACTOR, { deviceIds: [DEV1.id] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adapter.name).toBe("blocked");
    expect(r.adapter.configUpdatePush).toBe(false);
    expect(r.devices[0].dispatched).toBe(false);
    expect(r.devices[0].reason).toBe("adapter_disabled");
    const cmd = tables.system_device_commands.find((c) => c.command_type === "config_update");
    expect(cmd?.state).toBe("failed");
    expect((cmd?.result as Row)?.reason).toBe("adapter_disabled");
    expect(tables.device_config_revisions[0].status).toBe("failed");
  });

  it("rejects devices with no approved revision", async () => {
    delete process.env[ENV];
    const { db } = fakeDb(baseSeed());
    const r = await dispatchConfigRollout(db, ACTOR, { deviceIds: [DEV1.id] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.devices[0].ok).toBe(false);
    expect(r.devices[0].error).toContain("No approved");
  });
});

/* ── 4. Reported-state completion gating ─────────────────────────────────── */

describe("configRevisionToTargetState + refreshConfigRolloutTargets", () => {
  it("maps revision states onto the target machine — completed only from applied", () => {
    expect(configRevisionToTargetState("applied")).toEqual({ state: "completed", terminal: true });
    expect(configRevisionToTargetState("awaiting_report").state).toBe("verifying");
    expect(configRevisionToTargetState("approved").state).toBe("queued");
    expect(configRevisionToTargetState("failed").state).toBe("failed");
    expect(configRevisionToTargetState("superseded").state).toBe("cancelled");
    expect(configRevisionToTargetState("draft").state).toBe("approved");
  });

  const target = (over: Row = {}): Row => ({
    id: crypto.randomUUID(), campaign_id: CAMPAIGN_ID, device_id: DEV1.id,
    state: "queued", attempt: 0, last_error: null,
    result: { config_revision_id: "rev-1" }, state_entered_at: "2026-01-01T00:00:00Z",
    completed_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  });
  // config_revision_id must be a uuid for refresh to follow it.
  const REV_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const rev = (status: string, reported: Row | null = null): Row => ({
    id: REV_ID, device_id: DEV1.id, revision: 1, desired: { brightness: 50 },
    status, command_id: null, reported, actor: ACTOR.id, created_at: "2026-01-01T00:00:00Z",
  });

  it("applied revision → target completed with reported evidence", async () => {
    const { db, tables } = fakeDb({
      ...baseSeed(),
      kiosk_update_targets: [target({ result: { config_revision_id: REV_ID } })],
      device_config_revisions: [rev("applied", { brightness: 50 })],
    });
    const r = await refreshConfigRolloutTargets(db, ACTOR);
    expect(r.changed).toBe(1);
    expect(r.completed).toBe(1);
    const t = tables.kiosk_update_targets[0];
    expect(t.state).toBe("completed");
    expect(t.completed_at).not.toBeNull();
    const ev = (t.result as Row).completed_evidence as Row;
    expect(ev.revision_status).toBe("applied");
    expect((ev.reported as Row).brightness).toBe(50);
  });

  it("awaiting_report revision → verifying, NEVER completed without reported match", async () => {
    const { db, tables } = fakeDb({
      ...baseSeed(),
      kiosk_update_targets: [target({ result: { config_revision_id: REV_ID } })],
      // reported mismatch → reconcileReported would keep awaiting_report
      device_config_revisions: [rev("awaiting_report", { brightness: 10 })],
    });
    const r = await refreshConfigRolloutTargets(db, ACTOR);
    expect(r.verifying).toBe(1);
    expect(r.completed).toBe(0);
    expect(tables.kiosk_update_targets[0].state).toBe("verifying");
    expect(tables.kiosk_update_targets[0].completed_at).toBeNull();
  });

  it("failed revision → target failed with honest last_error", async () => {
    const { db, tables } = fakeDb({
      ...baseSeed(),
      kiosk_update_targets: [target({ result: { config_revision_id: REV_ID } })],
      device_config_revisions: [rev("failed")],
    });
    const r = await refreshConfigRolloutTargets(db, ACTOR);
    expect(r.failed).toBe(1);
    const t = tables.kiosk_update_targets[0];
    expect(t.state).toBe("failed");
    expect(t.last_error).toContain("config revision failed");
  });

  it("targets without a linked revision id are left untouched", async () => {
    const { db, tables } = fakeDb({
      ...baseSeed(),
      kiosk_update_targets: [target({ result: { note: "firmware rollout — no config link" } })],
      device_config_revisions: [],
    });
    const r = await refreshConfigRolloutTargets(db, ACTOR);
    expect(r.checked).toBe(0);
    expect(tables.kiosk_update_targets[0].state).toBe("queued");
  });
});

/* ── 5. Doc consistency ───────────────────────────────────────────────────── */

describe("docs/GATEWAY-ADAPTER.md consistency", () => {
  const doc = readFileSync(new URL("../docs/GATEWAY-ADAPTER.md", import.meta.url), "utf8");

  it("documents the Remote update delivery section and every interface method", () => {
    expect(doc).toContain("Remote update delivery");
    for (const m of [
      "GatewayUpdateCapable", "updateCapabilities",
      "deliverFirmwareArtifact", "pushConfigUpdate", "queryUpdateStatus",
      "reportInstalledVersion", "verifyReconnect", "requestRollback",
      "firmwareDelivery", "configUpdatePush", "updateStatusQuery",
      "installedVersionReport", "reconnectVerification", "rollbackSupport",
    ]) {
      expect(doc, `doc missing ${m}`).toContain(m);
    }
  });

  it("documents the verification gate and vendor-doc additions", () => {
    expect(doc).toContain("completed");
    expect(doc).toContain("Artifact transport");
    expect(doc).toContain("Resume semantics");
    expect(doc).toContain("Rollback image");
    expect(doc).toContain("Concurrency limits");
  });
});
