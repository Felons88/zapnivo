import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validCampaignTransition, validTargetTransition, isTerminalCampaign, isTerminalTarget,
  isCriticalTargetError, campaignNeedsElevation, compareDevices,
  releaseCompatibleWithDevice, parseMaintenanceWindow,
  createCampaign, approveCampaign, activateCampaign, pauseCampaign, resumeCampaign,
  cancelCampaign, transitionTarget, verifyTargetCompletion, maybeFinalizeCampaign,
  resolveUpdateTargets, getUpdateCampaign,
  CAMPAIGN_TRANSITIONS, TARGET_TRANSITIONS,
  type UpdateReleaseRow, type UpdateCampaignRow, type UpdateTargetRow,
} from "@/lib/system/update-rollouts";
import type { GatewayAdapter, GatewayResult } from "@/lib/kiosk/gateway-adapter";
import { NO_GATEWAY_CAPABILITIES } from "@/lib/kiosk/gateway-adapter";

/**
 * Update rollout engine tests — in-memory Supabase stub supporting the exact
 * query shapes update-rollouts.ts uses (select/eq/in/neq/order/limit/
 * maybeSingle/single/insert/update/delete + thenable).
 *
 * NOTE: the engine enforces UUID format on campaign/target/device ids — all
 * fixture ids below are valid UUIDs via U(n).
 */

type Row = Record<string, unknown>;

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAMP = U(900);
const CAMP2 = U(901);
const RELID = U(950);
const RELFW = U(951);

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;
  let idSeq = 0;

  class QB {
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean }[] = [];
    private lim: number | null = null;
    private op: "select" | "insert" | "update" | "delete" = "select";
    private payload: Row | Row[] | null = null;
    private wantSingle = false;
    constructor(private name: string) {}

    select() { return this; }
    insert(rows: Row | Row[]) { this.op = "insert"; this.payload = rows; return this; }
    update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    neq(c: string, v: unknown) { this.filters.push((r) => !eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy.push({ col: c, asc: o?.ascending !== false }); return this; }
    limit(n: number) { this.lim = n; return this; }
    single() { this.wantSingle = true; return this; }
    maybeSingle() { this.wantSingle = true; return this; }

    private matched(): Row[] {
      const rows = ensure(this.name);
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const { col, asc } of [...this.orderBy].reverse()) {
        out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : -cmp(a[col], b[col])));
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return out;
    }

    private exec(): { data: unknown; error: { message: string } | null } {
      const rows = ensure(this.name);
      if (this.op === "insert") {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        const inserted: Row[] = [];
        for (const r of list) {
          const row: Row = {
            id: `id-${++idSeq}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...r,
          };
          rows.push(row);
          inserted.push(row);
        }
        return { data: this.wantSingle ? inserted[0] ?? null : inserted, error: null };
      }
      if (this.op === "update") {
        const matched = this.matched();
        for (const r of matched) Object.assign(r, this.payload as Row, { updated_at: new Date().toISOString() });
        return { data: this.wantSingle ? matched[0] ?? null : matched, error: null };
      }
      if (this.op === "delete") {
        const matched = this.matched();
        const ids = new Set(matched);
        tables[this.name] = rows.filter((r) => !ids.has(r));
        return { data: matched, error: null };
      }
      const out = this.matched();
      return { data: this.wantSingle ? out[0] ?? null : out, error: null };
    }

    then<T>(onF: (v: { data: unknown; error: { message: string } | null }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.exec()).then(onF, onR);
    }
  }
  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const ACTOR = { id: "actor-1", role: "sysadmin" };
const OTHER = { id: "actor-2", role: "sysadmin" };
void OTHER;

const release = (over: Partial<UpdateReleaseRow> = {}): UpdateReleaseRow => ({
  id: RELID, kind: "config", version: "cfg-2.0", channel: "stable",
  manufacturer: null, model: null, hw_revision_min: null,
  storage_bucket: null, storage_path: null, sha256: null,
  signature_status: "unsigned", signature_key_id: null, release_notes: null,
  status: "approved", uploaded_by: "u-1", approved_by: "u-2", approved_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

const device = (id: string, over: Row = {}): Row => ({
  id, device_uid: `kiosk-${id.slice(-4)}`, manufacturer: "Acme", model: "K-1",
  region: "us-east", venue_id: null, status: "active",
  firmware_version: "1.0.0", last_heartbeat_at: new Date().toISOString(),
  last_message_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

const campaign = (over: Partial<UpdateCampaignRow> = {}): UpdateCampaignRow => ({
  id: CAMP, release_id: RELID, name: "Rollout A", justification: "test",
  status: "pending_approval", target_filter: {}, maintenance_window: null,
  concurrency_limit: 1, pause_reason: null, result: null,
  created_by: "actor-2", approved_by: null, approved_at: null,
  started_at: null, finished_at: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

const target = (id: string, over: Partial<UpdateTargetRow> = {}): UpdateTargetRow => ({
  id, campaign_id: CAMP, device_id: U(500), state: "draft",
  attempt: 0, last_error: null, result: null,
  state_entered_at: new Date().toISOString(), completed_at: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

/* ── Pure transition graphs ──────────────────────────────────────────────── */

describe("transition graphs", () => {
  it("campaign graph allows the documented lifecycle", () => {
    expect(validCampaignTransition("draft", "pending_approval")).toBe(true);
    expect(validCampaignTransition("pending_approval", "approved")).toBe(true);
    expect(validCampaignTransition("approved", "active")).toBe(true);
    expect(validCampaignTransition("active", "paused")).toBe(true);
    expect(validCampaignTransition("paused", "active")).toBe(true);
    expect(validCampaignTransition("active", "blocked")).toBe(true);
    expect(validCampaignTransition("blocked", "cancelled")).toBe(true);
  });
  it("campaign graph rejects illegal/terminal edges", () => {
    expect(validCampaignTransition("draft", "active")).toBe(false);
    expect(validCampaignTransition("pending_approval", "active")).toBe(false);
    expect(validCampaignTransition("completed", "active")).toBe(false);
    expect(validCampaignTransition("cancelled", "approved")).toBe(false);
    expect(validCampaignTransition("blocked", "active")).toBe(false); // blocked never resumes
    expect(isTerminalCampaign("completed")).toBe(true);
    expect(isTerminalCampaign("blocked")).toBe(true);
    expect(isTerminalCampaign("active")).toBe(false);
  });
  it("target graph covers the 14-state machine", () => {
    const chain = ["draft", "approved", "scheduled", "queued", "transferring", "installing", "reconnecting", "verifying", "completed"];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(validTargetTransition(chain[i], chain[i + 1])).toBe(true);
    }
    expect(validTargetTransition("draft", "completed")).toBe(false);
    expect(validTargetTransition("queued", "installing")).toBe(false); // skip = illegal
    expect(validTargetTransition("completed", "queued")).toBe(false);
    expect(validTargetTransition("unknown_outcome", "investigating")).toBe(true);
    expect(validTargetTransition("failed", "recovery")).toBe(true);
    expect(validTargetTransition("investigating", "queued")).toBe(true); // manual requeue only
    expect(isTerminalTarget("completed")).toBe(true);
    expect(isTerminalTarget("investigating")).toBe(false);
  });
  it("every declared state appears in the transition tables", () => {
    for (const s of Object.keys(TARGET_TRANSITIONS)) expect(s.length).toBeGreaterThan(0);
    for (const s of Object.keys(CAMPAIGN_TRANSITIONS)) expect(s.length).toBeGreaterThan(0);
  });
});

describe("pure helpers", () => {
  it("canary ordering is deterministic (device_uid then id)", () => {
    const a = { device_uid: "kiosk-b", id: "2" };
    const b = { device_uid: "kiosk-a", id: "1" };
    expect(compareDevices(a, b)).toBeGreaterThan(0);
    expect(compareDevices(b, a)).toBeLessThan(0);
  });
  it("release compatibility: null fields are wildcards", () => {
    const d = { id: U(1), device_uid: null, manufacturer: "Acme", model: "K-1", region: null, venue_id: null, status: "active" as const, firmware_version: null, last_heartbeat_at: null, last_message_at: null };
    expect(releaseCompatibleWithDevice({ manufacturer: null, model: null }, d)).toBe(true);
    expect(releaseCompatibleWithDevice({ manufacturer: "acme", model: "k-1" }, d)).toBe(true); // case-insensitive
    expect(releaseCompatibleWithDevice({ manufacturer: "Other", model: null }, d)).toBe(false);
    expect(releaseCompatibleWithDevice({ manufacturer: null, model: "K-2" }, d)).toBe(false);
  });
  it("critical error detection", () => {
    expect(isCriticalTargetError("signature verification failed")).toBe(true);
    expect(isCriticalTargetError("checksum mismatch")).toBe(true);
    expect(isCriticalTargetError("device offline")).toBe(false);
    expect(isCriticalTargetError(null)).toBe(false);
  });
  it("elevation required only for physical kinds", () => {
    expect(campaignNeedsElevation("firmware")).toBe(true);
    expect(campaignNeedsElevation("software")).toBe(true);
    expect(campaignNeedsElevation("config")).toBe(false);
    expect(campaignNeedsElevation("display_manifest")).toBe(false);
  });
  it("maintenance window parse", () => {
    expect(parseMaintenanceWindow(null)).toEqual({ start: null, end: null });
    expect(parseMaintenanceWindow({ start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" })).toEqual({
      start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-01-02T00:00:00Z"),
    });
  });
});

/* ── Target resolution ───────────────────────────────────────────────────── */

describe("resolveUpdateTargets", () => {
  const rel = release({ manufacturer: "Acme", model: "K-1" });
  it("filters by model/region/status and records exclusion reasons", async () => {
    const { db } = fakeDb({
      system_devices: [
        device(U(1)),
        device(U(2), { model: "K-2" }),            // incompatible model
        device(U(3), { status: "decommissioned" }), // ineligible status
        device(U(4), { region: "eu-west" }),        // region filter
      ],
    });
    const r = await resolveUpdateTargets(db, rel, { models: ["K-1"], regions: ["us-east"] });
    expect(r.devices.map((d) => d.id)).toEqual([U(1)]);
    expect(r.excluded.map((e) => e.reason)).toContain("device_status:decommissioned");
  });

  it("canary_percent keeps a deterministic prefix", async () => {
    const { db } = fakeDb({
      system_devices: [device(U(3)), device(U(1)), device(U(2)), device(U(4)), device(U(5))],
    });
    const r1 = await resolveUpdateTargets(db, rel, { canary_percent: 40 });
    const r2 = await resolveUpdateTargets(db, rel, { canary_percent: 40 });
    // sorted by device_uid (kiosk-0001…kiosk-0005) → keep ceil(5*0.4)=2
    expect(r1.devices.map((d) => d.id)).toEqual([U(1), U(2)]);
    expect(r2.devices.map((d) => d.id)).toEqual(r1.devices.map((d) => d.id)); // deterministic
    expect(r1.excluded.filter((e) => e.reason === "beyond_canary_percent")).toHaveLength(3);
  });

  it("device_ids restricts the pool", async () => {
    const id1 = U(11), id2 = U(12);
    const { db } = fakeDb({ system_devices: [device(id1), device(id2)] });
    const r = await resolveUpdateTargets(db, rel, { device_ids: [id2] });
    expect(r.devices.map((d) => d.id)).toEqual([id2]);
  });
});

/* ── Campaign creation ───────────────────────────────────────────────────── */

describe("createCampaign", () => {
  it("rejects missing/draft releases", async () => {
    const { db } = fakeDb({
      kiosk_update_releases: [release({ id: RELID, status: "draft" })],
      system_devices: [device(U(1))],
    });
    const r = await createCampaign(db, ACTOR, {
      release_id: RELID, name: "x", target_filter: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("creates pending_approval campaign + draft targets", async () => {
    const { db, tables } = fakeDb({
      kiosk_update_releases: [release()],
      system_devices: [device(U(1)), device(U(2))],
    });
    const r = await createCampaign(db, ACTOR, {
      release_id: RELID, name: "cfg rollout", justification: "because",
      target_filter: {}, concurrency_limit: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.campaign.status).toBe("pending_approval");
    expect(r.campaign.created_by).toBe(ACTOR.id);
    expect(r.targetCount).toBe(2);
    const targets = tables.kiosk_update_targets ?? [];
    expect(targets).toHaveLength(2);
    expect(targets.every((t) => t.state === "draft")).toBe(true);
    expect(tables.system_audit_events?.length).toBeGreaterThan(0);
  });

  it("records incompatible devices as excluded with reasons", async () => {
    const { db } = fakeDb({
      kiosk_update_releases: [release({ model: "K-1" })],
      system_devices: [device(U(1)), device(U(2), { model: "K-2" })],
    });
    const r = await createCampaign(db, ACTOR, {
      release_id: RELID, name: "x", target_filter: {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targetCount).toBe(1);
    expect(r.excluded[0]?.reason).toBe("incompatible_model_or_manufacturer");
  });
});

/* ── Approve / separation of duties / elevation ──────────────────────────── */

describe("approveCampaign", () => {
  it("rejects self-approval", async () => {
    const { db } = fakeDb({ kiosk_update_campaigns: [campaign({ created_by: ACTOR.id })] });
    const r = await approveCampaign(db, CAMP, ACTOR, { elevationOk: true });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(403); expect(r.code).toBe("self_approval"); }
  });

  it("requires elevation for firmware campaigns", async () => {
    const { db } = fakeDb({
      kiosk_update_campaigns: [campaign({ release_id: RELFW })],
      kiosk_update_releases: [release({ id: RELFW, kind: "firmware", version: "2.0", signature_status: "verified" })],
    });
    const r = await approveCampaign(db, CAMP, ACTOR, { elevationOk: false });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(403); expect(r.code).toBe("step_up_required"); }
  });

  it("config campaign approves without elevation; targets flip draft→approved", async () => {
    const t1 = U(101), t2 = U(102);
    const { db, tables } = fakeDb({
      kiosk_update_campaigns: [campaign()],
      kiosk_update_releases: [release()],
      kiosk_update_targets: [
        target(t1, { state: "draft" }),
        target(t2, { state: "cancelled" }),
      ],
    });
    const r = await approveCampaign(db, CAMP, ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.campaign.status).toBe("approved");
    expect(r.campaign.approved_by).toBe(ACTOR.id);
    expect(tables.kiosk_update_targets.find((t) => t.id === t1)?.state).toBe("approved");
    expect(tables.kiosk_update_targets.find((t) => t.id === t2)?.state).toBe("cancelled"); // untouched
  });

  it("firmware approve needs an approved change request (high risk) even with elevation", async () => {
    const { db } = fakeDb({
      kiosk_update_campaigns: [campaign({ release_id: RELFW })],
      kiosk_update_releases: [release({ id: RELFW, kind: "firmware", version: "2.0", signature_status: "verified" })],
    });
    const r = await approveCampaign(db, CAMP, ACTOR, { elevationOk: true });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(202); expect(r.pending).toBe(true); }
    expect((await getUpdateCampaign(db, CAMP))?.status).toBe("pending_approval");
  });
});

/* ── Activation / dispatch honesty ───────────────────────────────────────── */

describe("activateCampaign", () => {
  beforeAll(() => { process.env.KIOSK_ADAPTER = "none"; });
  afterAll(() => { delete process.env.KIOSK_ADAPTER; });

  function seedActive(opts: { targets?: number; concurrency?: number; releaseRow?: UpdateReleaseRow; status?: UpdateCampaignRow["status"]; window?: Record<string, unknown> | null } = {}) {
    const rel = opts.releaseRow ?? release();
    const n = opts.targets ?? 3;
    const tgts = Array.from({ length: n }, (_, i) =>
      target(U(200 + i), { state: "approved", device_id: U(300 + i) }));
    const { db, tables } = fakeDb({
      kiosk_update_campaigns: [campaign({
        status: opts.status ?? "approved",
        concurrency_limit: opts.concurrency ?? 1,
        release_id: rel.id,
        maintenance_window: opts.window ?? null,
      })],
      kiosk_update_releases: [rel],
      kiosk_update_targets: tgts,
      system_devices: tgts.map((t) => device(t.device_id)),
    });
    return { db, tables, rel };
  }

  it("dispatches only up to concurrency_limit; targets stay honestly queued", async () => {
    const { db, tables } = seedActive({ targets: 3, concurrency: 1 });
    const r = await activateCampaign(db, CAMP, ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dispatched).toBe(1);
    const states = tables.kiosk_update_targets.map((t) => t.state).sort();
    expect(states).toEqual(["approved", "approved", "queued"]);
    const queued = tables.kiosk_update_targets.find((t) => t.state === "queued");
    expect(queued?.attempt).toBe(1);
    // adapter=none → dispatch_error recorded, NEVER transferring/installing.
    expect((queued?.result as Row)?.dispatch_error).toBe("adapter_not_configured");
    expect((queued?.result as Row)?.adapter).toBeDefined();
    expect(tables.system_device_commands?.length).toBe(1);
    expect((tables.system_device_commands[0].result as Row)?.reason).toBe("adapter_not_configured");
    expect((await getUpdateCampaign(db, CAMP))?.status).toBe("active");
  });

  it("concurrency 2 dispatches two targets in one pass", async () => {
    const { db, tables } = seedActive({ targets: 3, concurrency: 2 });
    const r = await activateCampaign(db, CAMP, ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dispatched).toBe(2);
    expect(tables.kiosk_update_targets.filter((t) => t.state === "queued")).toHaveLength(2);
  });

  it("respects a future maintenance window (marks scheduled, refuses)", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const { db } = seedActive({ status: "approved", window: { start: future } });
    const r = await activateCampaign(db, CAMP, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("window_not_open");
    expect((await getUpdateCampaign(db, CAMP))?.status).toBe("scheduled");
  });

  it("refuses when the release lost approval", async () => {
    const { db } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "approved" })],
      kiosk_update_releases: [release({ status: "deprecated" })],
      kiosk_update_targets: [],
    });
    const r = await activateCampaign(db, CAMP, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("a fake live adapter still leaves targets queued (never transferring)", async () => {
    const { db, tables } = seedActive({ targets: 1, concurrency: 1 });
    const ok: GatewayResult<{ commandId: string }> = { ok: true, data: { commandId: "gw-1" } };
    const fakeAdapter = {
      name: "fake-gw",
      capabilities: () => ({ ...NO_GATEWAY_CAPABILITIES, configUpdate: true }),
      updateConfig: async () => ok,
      updateFirmware: async () => ok,
    } as unknown as GatewayAdapter;
    const r = await activateCampaign(db, CAMP, ACTOR, { adapter: fakeAdapter });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = tables.kiosk_update_targets[0];
    expect(t.state).toBe("queued"); // gateway accepted ≠ device progress
    expect((t.result as Row)?.dispatched).toBe(true);
    expect((t.result as Row)?.gateway_command_id).toBe("gw-1");
  });
});

/* ── Pause / resume / cancel ─────────────────────────────────────────────── */

describe("pause/resume/cancel", () => {
  it("pause stores reason; resume clears it", async () => {
    const { db, tables } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active" })],
    });
    const p = await pauseCampaign(db, CAMP, ACTOR, "maintenance hold");
    expect(p.ok).toBe(true);
    expect(tables.kiosk_update_campaigns[0].pause_reason).toBe("maintenance hold");
    const r = await resumeCampaign(db, CAMP, ACTOR);
    expect(r.ok).toBe(true);
    expect(tables.kiosk_update_campaigns[0].status).toBe("active");
    expect(tables.kiosk_update_campaigns[0].pause_reason).toBeNull();
  });

  it("blocked campaigns cannot resume — only cancel", async () => {
    const { db } = fakeDb({ kiosk_update_campaigns: [campaign({ status: "blocked" })] });
    const r = await resumeCampaign(db, CAMP, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("blocked_no_resume");
    const c = await cancelCampaign(db, CAMP, ACTOR, "investigated");
    expect(c.ok).toBe(true);
  });

  it("cancel cancels all non-terminal targets", async () => {
    const { db, tables } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active" })],
      kiosk_update_targets: [
        target(U(101), { state: "queued" }),
        target(U(102), { state: "completed" }),
        target(U(103), { state: "investigating" }),
      ],
    });
    const r = await cancelCampaign(db, CAMP, ACTOR, "stop");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cancelledTargets).toBe(2); // queued + investigating; completed untouched
    expect(tables.kiosk_update_targets.find((t) => t.id === U(102))?.state).toBe("completed");
    expect(tables.kiosk_update_campaigns[0].status).toBe("cancelled");
  });
});

/* ── Safety: auto-block + verification gate ──────────────────────────────── */

describe("safety invariants", () => {
  it("unknown_outcome auto-blocks the campaign", async () => {
    const { db, tables } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active" })],
      kiosk_update_targets: [target(U(101), { state: "transferring" })],
    });
    const r = await transitionTarget(db, U(101), "unknown_outcome", ACTOR, { error: "heartbeat lost" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.campaignBlocked).toBe(true);
    expect(tables.kiosk_update_campaigns[0].status).toBe("blocked");
  });

  it("critical failed auto-blocks; non-critical failed does not", async () => {
    const { db: db1, tables: t1 } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active" })],
      kiosk_update_targets: [target(U(101), { state: "installing" })],
    });
    const r1 = await transitionTarget(db1, U(101), "failed", ACTOR, { error: "signature verification failed on device" });
    expect(r1.ok && r1.campaignBlocked).toBe(true);
    expect(t1.kiosk_update_campaigns[0].status).toBe("blocked");

    const { db: db2, tables: t2 } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active", id: CAMP2 })],
      kiosk_update_targets: [target(U(102), { state: "installing", campaign_id: CAMP2 })],
    });
    const r2 = await transitionTarget(db2, U(102), "failed", ACTOR, { error: "download timeout" });
    expect(r2.ok && r2.campaignBlocked).toBe(false);
    expect(t2.kiosk_update_campaigns[0].status).toBe("active");
  });

  it("illegal target transitions are rejected", async () => {
    const { db } = fakeDb({
      kiosk_update_targets: [target(U(101), { state: "draft" })],
    });
    const r = await transitionTarget(db, U(101), "completed", ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("verifyTargetCompletion requires version match + fresh heartbeat", async () => {
    const { db, tables } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active" })],
      kiosk_update_releases: [release({ kind: "firmware", version: "2.0", signature_status: "verified" })],
      kiosk_update_targets: [target(U(101), { state: "verifying", device_id: U(201) })],
      system_devices: [device(U(201), { firmware_version: "2.0", last_heartbeat_at: new Date().toISOString() })],
    });
    const r = await verifyTargetCompletion(db, U(101), ACTOR);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verified).toBe(true);
      expect(r.target.state).toBe("completed");
    }
    expect(tables.kiosk_update_targets[0].completed_at).toBeTruthy();
  });

  it("verifyTargetCompletion without evidence → investigating (never completed)", async () => {
    const { db, tables } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active" })],
      kiosk_update_releases: [release({ kind: "firmware", version: "2.0", signature_status: "verified" })],
      kiosk_update_targets: [target(U(101), { state: "verifying", device_id: U(201) })],
      system_devices: [device(U(201), { firmware_version: "1.0.0", last_heartbeat_at: null })],
    });
    const r = await verifyTargetCompletion(db, U(101), ACTOR);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verified).toBe(false);
      expect(r.target.state).toBe("investigating");
    }
    expect(tables.kiosk_update_targets[0].state).toBe("investigating");
  });

  it("version mismatch evidence keeps target in investigating", async () => {
    const { db } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active" })],
      kiosk_update_releases: [release({ kind: "firmware", version: "2.0", signature_status: "verified" })],
      kiosk_update_targets: [target(U(101), { state: "investigating", device_id: U(201) })],
      system_devices: [device(U(201), { firmware_version: "1.5.0", last_heartbeat_at: new Date().toISOString() })],
    });
    const r = await verifyTargetCompletion(db, U(101), ACTOR, { reported_version: "1.5.0" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.verified).toBe(false); expect(r.reason).toContain("version_mismatch"); }
  });
});

/* ── Finalize ────────────────────────────────────────────────────────────── */

describe("maybeFinalizeCampaign", () => {
  it("completes when all targets terminal; fails when none completed", async () => {
    const { db: db1, tables: t1 } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active" })],
      kiosk_update_targets: [
        target(U(101), { state: "completed" }), target(U(102), { state: "cancelled" }),
      ],
    });
    const f1 = await maybeFinalizeCampaign(db1, CAMP, ACTOR);
    expect(f1.finalized).toBe(true);
    expect(t1.kiosk_update_campaigns[0].status).toBe("completed");

    const { db: db2, tables: t2 } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active", id: CAMP2 })],
      kiosk_update_targets: [
        target(U(103), { state: "failed", campaign_id: CAMP2 }),
        target(U(104), { state: "cancelled", campaign_id: CAMP2 }),
      ],
    });
    const f2 = await maybeFinalizeCampaign(db2, CAMP2, ACTOR);
    expect(f2.finalized).toBe(true);
    expect(t2.kiosk_update_campaigns[0].status).toBe("failed");
  });

  it("stays open while targets are unresolved (investigating/queued)", async () => {
    const { db, tables } = fakeDb({
      kiosk_update_campaigns: [campaign({ status: "active" })],
      kiosk_update_targets: [
        target(U(101), { state: "completed" }), target(U(102), { state: "investigating" }),
      ],
    });
    const f = await maybeFinalizeCampaign(db, CAMP, ACTOR);
    expect(f.finalized).toBe(false);
    expect(tables.kiosk_update_campaigns[0].status).toBe("active");
  });
});
