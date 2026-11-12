import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  detailHasSecretMaterial, runPhysicalSuiteRefusal, runSimulatedSuite,
  verifyCertificationChain, type CertificationRunRecord,
} from "@/lib/kiosk/certification-runner";
import { CERTIFICATION_CHECKS } from "@/app/system/kiosks/certification/checklist";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * Certification runner tests — runSimulatedSuite executes the automated
 * checks against the REAL libs via the kiosk simulator (in-memory Supabase
 * stub, same philosophy as hardware-certification.test.ts) and records every
 * result through the shared hash-chained insert path.
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
  const UNIQ: Record<string, string[]> = {
    kiosk_events: ["event_id"],
    power_banks: ["serial"],
    kiosk_slots: ["kiosk_id,slot_number"],
    system_device_messages: ["device_id,message_id"],
    device_commands: ["idempotency_key"],
  };
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    private onConflict: string | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    upsert(p: unknown, o?: { onConflict?: string }) { this.op = "upsert"; this.payload = p; this.onConflict = o?.onConflict ?? null; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    neq(c: string, v: unknown) { this.filters.push((r) => !eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    not(c: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (r[c] ?? null) !== v); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) <= 0); return this; }
    or() { return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }
    filter() { return this; }

    private run(): { data: Row[] | Row | null; error: { code: string; message: string } | null } {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert" || this.op === "upsert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const out: Row[] = [];
        for (const item of items) {
          if (this.op === "upsert" && this.onConflict) {
            const cols = this.onConflict.split(",");
            const ex = rows.find((r) => cols.every((c) => eqv(r[c], item[c])));
            if (ex) { Object.assign(ex, item); out.push(ex); continue; }
          }
          for (const spec of UNIQ[this.name] ?? []) {
            const cols = spec.split(",");
            if (cols.some((c) => item[c] == null)) continue;
            if (rows.some((r) => cols.every((c) => eqv(r[c], item[c]))))
              return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
          const row: Row = { ...item };
          // system_devices.id is a uuid FK target (certification device_id) —
          // give it a real uuid so isUuid-gated paths behave like production.
          if (row.id == null) row.id = this.name === "system_devices" ? randomUUID() : `${this.name}-${(seq[this.name] = (seq[this.name] ?? 0) + 1)}`;
          rows.push(row);
          out.push(row);
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
      const { data, error } = this.finish();
      if (error) return { data: null, error };
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (rows.length === 0) return { data: null, error: { code: "PGRST116", message: "0 rows" } };
      return { data: rows[0], error: null };
    }
    maybeSingle() {
      const { data, error } = this.finish();
      if (error) return { data: null, error };
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.finish()).then(onF, onR);
    }
  }

  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

function seedDb(extra: Record<string, Row[]> = {}) {
  return fakeDb({
    system_devices: [], system_device_messages: [], system_audit_events: [],
    kiosks: [], device_events: [], kiosk_events: [], kiosk_slots: [],
    power_banks: [], rentals: [], device_commands: [], rental_exceptions: [],
    audit_logs: [], system_certification_runs: [], system_hardware_profiles: [],
    ...extra,
  });
}

const KEK = "ef".repeat(32);
let prevKek: string | undefined;
beforeEach(() => {
  resetRateLimits();
  prevKek = process.env.DEVICE_CREDENTIAL_KEK;
  process.env.DEVICE_CREDENTIAL_KEK = KEK;
});
afterEach(() => {
  if (prevKek === undefined) delete process.env.DEVICE_CREDENTIAL_KEK;
  else process.env.DEVICE_CREDENTIAL_KEK = prevKek;
});

const EXPECTED_SIMULATED = CERTIFICATION_CHECKS.filter((c) => c.tier === "simulated").length;
const EXPECTED_GATEWAY = CERTIFICATION_CHECKS.filter((c) => c.tier === "gateway_contract").length;

describe("runSimulatedSuite — records every check through the hash-chained path", () => {
  it("produces one recorded run per automated check, correct tiers, intact chains", async () => {
    const { db, tables } = seedDb();
    const suite = await runSimulatedSuite(db, { actorId: "runner-test" });

    expect(suite.simulated).toBe(true);
    expect(suite.device_id).toBeTruthy();
    expect(suite.results.length).toBe(EXPECTED_SIMULATED + EXPECTED_GATEWAY);
    expect(suite.recorded).toBe(suite.results.length);
    expect(suite.results.every((r) => r.recorded)).toBe(true);

    const runs = tables.system_certification_runs as Row[];
    expect(runs.length).toBe(EXPECTED_SIMULATED + EXPECTED_GATEWAY);
    // Only simulated + gateway_contract tiers — NEVER physical.
    expect(runs.every((r) => r.tier === "simulated" || r.tier === "gateway_contract")).toBe(true);
    expect(runs.some((r) => r.tier === "physical")).toBe(false);
    // Every detail is marked simulated + carries the suite_run_id.
    for (const r of runs) {
      const d = r.detail as Record<string, unknown>;
      expect(d.simulated).toBe(true);
      expect(d.suite_run_id).toBe(suite.suite_run_id);
      expect(d.via).toBe("kiosk-simulator");
    }
    // No credential material anywhere in the ledger.
    expect(JSON.stringify(runs)).not.toContain("znd_");
    expect(runs.every((r) => !detailHasSecretMaterial(r.detail))).toBe(true);

    // Hash chains verify per (device_id, tier).
    for (const tier of ["simulated", "gateway_contract"] as const) {
      const chain = runs.filter((r) => r.tier === tier) as unknown as CertificationRunRecord[];
      expect(verifyCertificationChain(chain).ok).toBe(true);
    }

    // Key lifecycle checks passed.
    const byKey = new Map(suite.results.map((r) => [`${r.tier}:${r.check_key}`, r.status]));
    for (const k of [
      "simulated:provisioning_contract", "simulated:hmac_auth", "simulated:heartbeat",
      "simulated:inventory_reporting", "simulated:rotation_overlap", "simulated:offline_detection",
      "simulated:reconnection", "simulated:return_detection", "simulated:duplicate_replay_rejection",
      "simulated:invalid_signature", "simulated:revoked_credential", "simulated:expired_credential",
      "gateway_contract:message_schema_conformance", "gateway_contract:idempotency_keys",
      "gateway_contract:dispense_command_path", "gateway_contract:ack_correlation",
    ]) {
      expect(byKey.get(k), `${k} should pass`).toBe("pass");
    }
  });

  it("a second suite run extends the same hash chain (prev_hash linkage)", async () => {
    const { db, tables } = seedDb();
    const s1 = await runSimulatedSuite(db, { actorId: "runner-test" });
    const s2 = await runSimulatedSuite(db, { actorId: "runner-test" });
    expect(s1.device_id).not.toBe(s2.device_id); // each run gets its own sim device → own chain
    const runs = tables.system_certification_runs as Row[];
    for (const tier of ["simulated", "gateway_contract"]) {
      const chain = runs.filter((r) => r.tier === tier && (r.detail as Row).suite_run_id === s2.suite_run_id) as unknown as CertificationRunRecord[];
      expect(verifyCertificationChain(chain).ok).toBe(true);
    }
  });

  it("binds results to an existing SIM-MARKED device", async () => {
    const { db, tables } = seedDb();
    const first = await runSimulatedSuite(db, { actorId: "runner-test" });
    // Re-run against the same sim device.
    const second = await runSimulatedSuite(db, { deviceId: first.device_id, actorId: "runner-test" });
    expect(second.device_id).toBe(first.device_id);
    expect(second.results.every((r) => r.recorded)).toBe(true);
    // device_id chain now has both suites' runs.
    const deviceRuns = (tables.system_certification_runs as Row[]).filter((r) => r.device_id === first.device_id);
    expect(deviceRuns.length).toBe((EXPECTED_SIMULATED + EXPECTED_GATEWAY) * 2);
  });
});

describe("runSimulatedSuite — honesty guards", () => {
  it("REFUSES a non-simulator device id and records nothing", async () => {
    const { db, tables } = seedDb({
      system_devices: [{
        id: "99999999-9999-4999-8999-999999999999", device_uid: "kiosk-real-1",
        serial_number: "ZP-REAL-9", status: "active", adapter_type: "vendor-x",
        capabilities: {}, auth_method: "hmac_sha256",
      }],
    });
    const before = (tables.system_certification_runs as Row[]).length;
    const suite = await runSimulatedSuite(db, { deviceId: "99999999-9999-4999-8999-999999999999", actorId: "runner-test" });
    expect(suite.ok).toBe(false);
    expect(suite.refused).toBe(true);
    expect(suite.recorded).toBe(0);
    expect(suite.results.every((r) => !r.recorded && r.status === "blocked")).toBe(true);
    expect((tables.system_certification_runs as Row[]).length).toBe(before);
  });

  it("physical tier is refused — blocked results, zero rows written", async () => {
    const { db, tables } = seedDb();
    const before = (tables.system_certification_runs as Row[]).length;
    const suite = await runPhysicalSuiteRefusal();
    expect(suite.refused).toBe(true);
    expect(suite.ok).toBe(false);
    expect(suite.recorded).toBe(0);
    expect(suite.results.length).toBe(CERTIFICATION_CHECKS.filter((c) => c.tier === "physical").length);
    expect(suite.results.every((r) => r.tier === "physical" && r.status === "blocked" && !r.recorded)).toBe(true);
    expect((tables.system_certification_runs as Row[]).length).toBe(before);
  });

  it("setup failure records honest 'blocked' runs, never fabricated passes", async () => {
    const { db, tables } = seedDb();
    const saved = process.env.DEVICE_CREDENTIAL_KEK;
    delete process.env.DEVICE_CREDENTIAL_KEK; // provisioning cannot issue credentials
    try {
      const suite = await runSimulatedSuite(db, { actorId: "runner-test" });
      expect(suite.ok).toBe(false);
      // Every planned check recorded as blocked — no passes fabricated.
      expect(suite.results.every((r) => r.status === "blocked" && r.recorded)).toBe(true);
      expect(suite.results.some((r) => r.status === "pass")).toBe(false);
      const runs = tables.system_certification_runs as Row[];
      expect(runs.length).toBe(EXPECTED_SIMULATED + EXPECTED_GATEWAY);
      expect(runs.every((r) => (r.status as string) === "blocked")).toBe(true);
    } finally {
      process.env.DEVICE_CREDENTIAL_KEK = saved;
    }
  });
});
