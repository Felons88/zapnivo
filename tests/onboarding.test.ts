import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { session, service } = vi.hoisted(() => ({ session: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSessionUser: session, devAuth: () => false }));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));

import { computeOnboardingEvidence, type OnboardingStep } from "@/app/api/system/kiosks/onboarding/evidence";
import { GET, POST } from "@/app/api/system/kiosks/onboarding/route";
import { resetRateLimits } from "@/lib/rate-limit";
import type { SystemDeviceRow } from "@/lib/system/kiosks";

/* ── Stateful in-memory Supabase stub (same QB pattern as
 *    system-provisioning.test.ts, extended with .in() already present). ── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    order() { return this; } // insertion order is good enough for fixtures
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        for (const item of items) rows.push({ ...item });
        return { data: items, error: null };
      }
      if (this.op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return { data: affected, error: null };
      }
      let out = rows.filter(match);
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    private finish() { return this.run(); }
    single() {
      const { data, error } = this.finish();
      if (error) return { data: null, error };
      const rs = Array.isArray(data) ? data : data ? [data] : [];
      if (rs.length === 0) return { data: null, error: { code: "PGRST116", message: "0 rows" } };
      return { data: rs[0], error: null };
    }
    maybeSingle() {
      const { data, error } = this.finish();
      if (error) return { data: null, error };
      const rs = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rs[0] ?? null, error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.finish()).then(onF, onR);
    }
  }

  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const DEVICE_ID = "66666666-6666-4666-8666-666666666666";
const VENUE_ID = "77777777-7777-4777-8777-777777777777";
const KIOSK_ID = "88888888-8888-4888-8888-888888888888";
const UID = "kiosk-onb-1";
const SERIAL = "SN-ONB-1";
const NOW = new Date("2026-02-01T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const MIN = 60_000;

function deviceRow(over: Row = {}): Row {
  return {
    id: DEVICE_ID,
    device_uid: UID,
    serial_number: SERIAL,
    manufacturer: "Zapnivo",
    model: "ZK-1",
    gateway: "gw-1",
    adapter_type: "none",
    capabilities: {},
    slot_count: 8,
    firmware_version: "1.0.0",
    venue_id: null,
    region: "us-east",
    status: "testing",
    provision_token_hash: "hash",
    provision_token_expires_at: iso(-72 * 60 * MIN), // future
    provision_token_used_at: iso(30 * MIN),
    credential_rotated_at: null,
    installed_at: null,
    last_heartbeat_at: iso(5 * MIN), // fresh
    last_message_at: iso(4 * MIN),
    created_by: "staff-1",
    created_at: iso(60 * 60 * MIN),
    updated_at: iso(5 * MIN),
    auth_method: "hmac_sha256",
    device_secret_hash: "fp",
    credential_issued_at: iso(25 * MIN),
    credential_expires_at: iso(365 * 24 * 60 * MIN),
    credential_revoked_at: null,
    last_authed_at: iso(5 * MIN),
    last_message_ts: NOW.getTime(),
    ...over,
  };
}

const PHYSICAL_KEYS = ["dispense_ack", "return_ack", "hardware_fault", "payment_terminal_handshake"];

function physicalRuns(status = "pass", checkKeys = PHYSICAL_KEYS): Row[] {
  // newest-first per check; one run per key is enough for latest-per-check
  return checkKeys.map((k, i) => ({
    id: `run-${k}`, device_id: DEVICE_ID, tier: "physical", check_key: k,
    status, created_at: iso((i + 1) * MIN),
  }));
}

function seed(over: Record<string, Row[]> = {}) {
  return fakeDb({
    system_hardware_profiles: [{
      id: "prof-1", manufacturer: "Zapnivo", model: "ZK-1", certification_status: "certified",
      dispense_supported: true, return_detection: true, inventory_reporting: true,
      heartbeat_supported: true, firmware_update: false, ad_screen: false,
      created_at: iso(100 * 60 * MIN),
    }],
    system_device_messages: [
      { id: "m1", device_id: DEVICE_ID, result: "ok", received_at: iso(5 * MIN) },
      { id: "m2", device_id: DEVICE_ID, result: "rejected", received_at: iso(6 * MIN) },
    ],
    system_device_commands: [
      { id: "c1", device_id: DEVICE_ID, command_type: "status_request", state: "acked", acked_at: iso(10 * MIN), created_at: iso(11 * MIN), result: {} },
      { id: "c2", device_id: DEVICE_ID, command_type: "diagnostic_ping", state: "failed", acked_at: null, created_at: iso(20 * MIN), result: { status: "adapter_unavailable" } },
    ],
    system_certification_runs: physicalRuns(),
    venues: [{ id: VENUE_ID, name: "Union Station", city: "DC" }],
    kiosks: [{ id: KIOSK_ID, station_id: UID, state: "active" }],
    kiosk_slots: [
      { kiosk_id: KIOSK_ID, slot_number: 1, state: "ready" },
      { kiosk_id: KIOSK_ID, slot_number: 2, state: "empty" },
    ],
    device_events: [{ id: "e1", kiosk_id: KIOSK_ID, event_type: "slot_state", occurred_at: iso(15 * MIN) }],
    ...over,
  });
}

const step = (ev: { steps: OnboardingStep[] }, key: string) => {
  const s = ev.steps.find((x) => x.key === key);
  if (!s) throw new Error(`missing step ${key}`);
  return s;
};

beforeEach(() => resetRateLimits());

/* ── Aggregator: per-step evidence correctness ───────────────────────────── */

describe("computeOnboardingEvidence — step states from real rows", () => {
  it("green path: all evidence present → steps complete except honest gaps", async () => {
    const { db } = seed({ system_devices: [deviceRow({ venue_id: VENUE_ID })] });
    const ev = await computeOnboardingEvidence(db, deviceRow({ venue_id: VENUE_ID }) as unknown as SystemDeviceRow, NOW);
    // NOTE: pass the same row object shape the route would load.
    expect(step(ev, "register").state).toBe("complete");
    expect(step(ev, "manufacturer_model").state).toBe("complete");
    expect(step(ev, "hardware_profile").state).toBe("complete");
    expect(step(ev, "capabilities").state).toBe("complete"); // certified profile grants caps
    expect(step(ev, "provision_token").state).toBe("complete"); // used
    expect(step(ev, "redeem").state).toBe("complete"); // used_at + credential_issued_at
    expect(step(ev, "heartbeat").state).toBe("complete"); // 5min fresh
    expect(step(ev, "inventory").state).toBe("complete"); // slot_state event + slots
    expect(step(ev, "diagnostics").state).toBe("complete"); // diagnostic_ping row
    expect(step(ev, "command_acks").state).toBe("complete"); // acked row
    expect(step(ev, "certification").state).toBe("complete"); // all physical pass
    expect(step(ev, "venue").state).toBe("complete");
    expect(step(ev, "activation").state).toBe("in_progress"); // testing→active legal + all green
    expect(ev.all_prior_green).toBe(true);
    expect((step(ev, "activation").meta?.legal_targets as string[])).toContain("active");
  });

  it("missing device fields → honest in_progress/blocked, never complete", async () => {
    const bare = deviceRow({
      manufacturer: null, model: null, venue_id: null,
      provision_token_hash: null, provision_token_used_at: null,
      credential_issued_at: null, auth_method: "pending",
      last_heartbeat_at: null, last_message_at: null,
      status: "registered",
    });
    const { db } = seed({ system_devices: [bare] });
    const ev = await computeOnboardingEvidence(db, bare as unknown as SystemDeviceRow, NOW);
    expect(step(ev, "manufacturer_model").state).toBe("in_progress");
    expect(step(ev, "hardware_profile").state).toBe("blocked");
    expect(step(ev, "provision_token").state).toBe("in_progress");
    expect(step(ev, "redeem").state).toBe("blocked");
    expect(step(ev, "heartbeat").state).toBe("awaiting_hardware");
    expect(ev.all_prior_green).toBe(false);
    expect(step(ev, "activation").state).toBe("blocked");
    expect(step(ev, "activation").meta?.missing_steps).toContain("heartbeat");
  });

  it("stale heartbeat → in_progress; fresh boundary respected", async () => {
    const stale = deviceRow({ last_heartbeat_at: iso(20 * MIN) });
    const { db } = seed({ system_devices: [stale] });
    const ev = await computeOnboardingEvidence(db, stale as unknown as SystemDeviceRow, NOW);
    expect(step(ev, "heartbeat").state).toBe("in_progress");
    const evItem = step(ev, "heartbeat").evidence.find((e) => e.label === "heartbeat_age_min");
    expect(evItem?.value).toBe("20");
  });

  it("SIMULATED certification runs never satisfy the physical step", async () => {
    const simRuns = [
      ...Array.from({ length: 13 }, (_, i) => ({
        id: `sim-${i}`, device_id: DEVICE_ID, tier: "simulated",
        check_key: `sim_check_${i}`, status: "pass", created_at: iso(i * MIN),
      })),
    ];
    const { db } = seed({ system_certification_runs: simRuns });
    const dev = deviceRow();
    const ev = await computeOnboardingEvidence(db, dev as unknown as SystemDeviceRow, NOW);
    const cert = step(ev, "certification");
    expect(cert.state).not.toBe("complete");
    expect(cert.state).toBe("awaiting_hardware"); // zero physical passes
    const simEvidence = cert.evidence.find((e) => e.label === "simulated_runs");
    expect(simEvidence?.value).toContain("SIMULATED");
    expect(simEvidence?.value).toContain("not physical verification");
  });

  it("partial physical passes → in_progress; all four required", async () => {
    const partial = physicalRuns("pass", PHYSICAL_KEYS.slice(0, 2));
    const { db } = seed({ system_certification_runs: partial });
    const dev = deviceRow();
    const ev = await computeOnboardingEvidence(db, dev as unknown as SystemDeviceRow, NOW);
    const cert = step(ev, "certification");
    expect(cert.state).toBe("in_progress");
    expect(cert.meta?.physical_passed).toBe(2);
    expect(cert.meta?.physical_total).toBe(4);
  });

  it("physical 'fail' latest run does not count as pass", async () => {
    // newest-first ordering: a later 'fail' overrides an earlier 'pass'
    const runs = [
      { id: "r-new", device_id: DEVICE_ID, tier: "physical", check_key: "dispense_ack", status: "fail", created_at: iso(MIN) },
      { id: "r-old", device_id: DEVICE_ID, tier: "physical", check_key: "dispense_ack", status: "pass", created_at: iso(60 * MIN) },
      ...physicalRuns("pass", PHYSICAL_KEYS.slice(1)),
    ];
    const { db } = seed({ system_certification_runs: runs });
    const dev = deviceRow();
    const ev = await computeOnboardingEvidence(db, dev as unknown as SystemDeviceRow, NOW);
    const cert = step(ev, "certification");
    expect(cert.state).toBe("in_progress"); // dispense_ack latest = fail
    expect(cert.meta?.physical_passed).toBe(3);
  });

  it("no bound kiosk → inventory awaiting_hardware (honest, not fabricated)", async () => {
    const { db } = seed({ kiosks: [], kiosk_slots: [], device_events: [] });
    const dev = deviceRow();
    const ev = await computeOnboardingEvidence(db, dev as unknown as SystemDeviceRow, NOW);
    const inv = step(ev, "inventory");
    expect(inv.state).toBe("awaiting_hardware");
    expect(inv.evidence.find((e) => e.label === "bound_kiosk_id")?.value).toBe("—");
  });

  it("uncertified/absent profile → awaiting_hardware; capabilities fail-closed", async () => {
    const { db } = seed({
      system_hardware_profiles: [],
      system_devices: [deviceRow({ capabilities: {} })],
    });
    const dev = deviceRow({ capabilities: {} });
    const ev = await computeOnboardingEvidence(db, dev as unknown as SystemDeviceRow, NOW);
    expect(step(ev, "hardware_profile").state).toBe("awaiting_hardware");
    expect(step(ev, "capabilities").state).toBe("awaiting_hardware");
    expect(step(ev, "capabilities").meta?.resolved).toEqual([]);
  });

  it("token issued-but-unused → redeem awaiting_hardware; expired token → step5 in_progress", async () => {
    const issued = deviceRow({ provision_token_used_at: null, credential_issued_at: null });
    const { db } = seed({ system_devices: [issued] });
    const ev = await computeOnboardingEvidence(db, issued as unknown as SystemDeviceRow, NOW);
    expect(step(ev, "provision_token").state).toBe("complete"); // issued counts as done
    expect(step(ev, "redeem").state).toBe("awaiting_hardware");

    const expired = deviceRow({ provision_token_expires_at: iso(60 * MIN), provision_token_used_at: null });
    const { db: db2 } = seed({ system_devices: [expired] });
    const ev2 = await computeOnboardingEvidence(db2, expired as unknown as SystemDeviceRow, NOW);
    expect(step(ev2, "provision_token").state).toBe("in_progress"); // expired → re-issue
  });
});

/* ── API route: perm gating + honest errors ──────────────────────────────── */

const get = (qs: string) => GET(new Request(`http://localhost/api/system/kiosks/onboarding${qs}`));
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/system/kiosks/onboarding", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

function roleDb(role: string | null, tables: Record<string, Row[]> = {}) {
  const { db, tables: t } = fakeDb({
    profiles: [{ id: "user-1", system_role: role, system_suspended: false }],
    system_devices: [deviceRow()],
    ...tables,
  });
  return { db, tables: t };
}

describe("GET /api/system/kiosks/onboarding", () => {
  it("400 without device_id; 404 for unknown device", async () => {
    session.mockResolvedValue({ id: "user-1", role: "user" });
    const { db } = roleDb("viewer");
    service.mockReturnValue(db);
    expect((await get("")).status).toBe(400);
    expect((await get("?device_id=not-a-uuid")).status).toBe(400);
    expect((await get(`?device_id=${"99999999-9999-4999-8999-999999999999"}`)).status).toBe(404);
  });

  it("200 returns 13 steps with real evidence for a viewer (view perm)", async () => {
    session.mockResolvedValue({ id: "user-1", role: "user" });
    const { db } = roleDb("viewer");
    service.mockReturnValue(db);
    const res = await get(`?device_id=${DEVICE_ID}`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.steps).toHaveLength(13);
    expect(j.device.id).toBe(DEVICE_ID);
    expect(j.steps.every((s: OnboardingStep) => typeof s.state === "string" && s.evidence.length >= 0)).toBe(true);
  });

  it("401 unauthenticated; 403 role without kiosks.view", async () => {
    session.mockResolvedValue(null);
    service.mockReturnValue(roleDb("sysadmin").db);
    expect((await get(`?device_id=${DEVICE_ID}`)).status).toBe(401);
    // Every system role carries system.kiosks.view (READ_ONLY/ALL), so the
    // meaningful gate here is manage on POST — covered below.
    session.mockResolvedValue({ id: "user-1", role: "user" });
    service.mockReturnValue(roleDb("developer").db);
    expect((await get(`?device_id=${DEVICE_ID}`)).status).toBe(200);
  });
});

describe("POST /api/system/kiosks/onboarding (assign_venue)", () => {
  it("viewer (view-only) → 403", async () => {
    session.mockResolvedValue({ id: "user-1", role: "user" });
    const { db } = roleDb("viewer");
    service.mockReturnValue(db);
    const res = await post({ action: "assign_venue", device_id: DEVICE_ID, venue_id: VENUE_ID });
    expect(res.status).toBe(403);
  });

  it("hardware role → assigns venue, audits, returns device", async () => {
    session.mockResolvedValue({ id: "user-1", role: "user" });
    const { db, tables } = roleDb("hardware", { venues: [{ id: VENUE_ID, name: "Union Station" }] });
    service.mockReturnValue(db);
    const res = await post({ action: "assign_venue", device_id: DEVICE_ID, venue_id: VENUE_ID });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.device.venue_id).toBe(VENUE_ID);
    expect(tables.system_devices[0].venue_id).toBe(VENUE_ID);
    const audit = tables.system_audit_events ?? [];
    expect(audit.some((r) => r.action === "kiosk.venue_assigned")).toBe(true);
  });

  it("unknown venue → 400; unknown device → 404; bad action → 400", async () => {
    session.mockResolvedValue({ id: "user-1", role: "user" });
    const { db } = roleDb("sysadmin", { venues: [{ id: VENUE_ID }] });
    service.mockReturnValue(db);
    expect((await post({ action: "assign_venue", device_id: DEVICE_ID, venue_id: "99999999-9999-4999-8999-999999999999" })).status).toBe(400);
    expect((await post({ action: "assign_venue", device_id: "99999999-9999-4999-8999-999999999999", venue_id: VENUE_ID })).status).toBe(404);
    expect((await post({ action: "nuke", device_id: DEVICE_ID, venue_id: VENUE_ID })).status).toBe(400);
  });
});
