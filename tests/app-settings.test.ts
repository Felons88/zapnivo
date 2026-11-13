import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import {
  APP_SETTING_REGISTRY,
  appSettingDef,
  getAppSetting,
  listAppSettings,
  setAppSetting,
  validateSettingValue,
} from "@/lib/system/app-settings";

/* ── Minimal stateful Supabase stub (same QB pattern as alert-emitters) ── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: unknown = null;
    private onConflict: string | null = null;
    private filters: ((r: Row) => boolean)[] = [];
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    upsert(p: unknown, opts?: { onConflict?: string }) { this.op = "upsert"; this.payload = p; this.onConflict = opts?.onConflict ?? null; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) <= 0); return this; }
    order() { return this; }
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        for (const item of items) rows.push({ created_at: new Date().toISOString(), ...item });
        return { data: items, error: null };
      }
      if (this.op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return { data: affected, error: null };
      }
      if (this.op === "upsert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const conflictCol = this.onConflict ?? "key";
        const out: Row[] = [];
        for (const item of items) {
          const existing = rows.find((r) => eqv(r[conflictCol], item[conflictCol]));
          if (existing) {
            Object.assign(existing, item);
            out.push(existing);
          } else {
            const row = { created_at: new Date().toISOString(), ...item };
            rows.push(row);
            out.push(row);
          }
        }
        return { data: out, error: null };
      }
      let out = rows.filter(match);
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

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const ACTOR = { id: "user-1", role: "sysadmin" };
const USER = { id: "user-1", email: "admin@dev.local", role: "admin", organizationId: null } as unknown as SessionUser;
const NOW = Date.now();
const iso = (ms: number) => new Date(NOW + ms).toISOString();

function elevationRow(over: Row = {}): Row {
  return {
    id: "elev-1",
    profile_id: "user-1",
    method: "totp",
    created_at: iso(-60_000),
    expires_at: iso(10 * 60_000),
    consumed_action: null,
    created_ip: null,
    ...over,
  };
}

const auditRows = (tables: Record<string, Row[]>) => tables.system_audit_events ?? [];

/* ── Registry + pure validation ──────────────────────────────────────────── */

describe("app settings registry", () => {
  it("contains only whitelisted nonsecret keys with risk levels", () => {
    expect(APP_SETTING_REGISTRY.length).toBeGreaterThanOrEqual(5);
    for (const d of APP_SETTING_REGISTRY) {
      expect(d.key).toMatch(/^[a-z0-9][a-z0-9_.-]{0,80}$/);
      expect(["low", "high"]).toContain(d.risk);
      expect(["boolean", "string"]).toContain(d.kind);
      expect(d.description.length).toBeGreaterThan(0);
    }
    expect(appSettingDef("maintenance.notice_enabled")?.risk).toBe("low");
    expect(appSettingDef("site.maintenance_mode")?.risk).toBe("high");
    expect(appSettingDef("does.not.exist")).toBeNull();
  });

  it("validateSettingValue enforces kind, length, and secret scan", () => {
    const boolDef = appSettingDef("maintenance.notice_enabled")!;
    expect(validateSettingValue(boolDef, true)).toEqual({ ok: true, value: true });
    expect(validateSettingValue(boolDef, "true")).toMatchObject({ ok: false });
    expect(validateSettingValue(boolDef, 1)).toMatchObject({ ok: false });

    const strDef = appSettingDef("support.public_hours")!;
    expect(validateSettingValue(strDef, "  Mon–Fri 9–6  ")).toEqual({ ok: true, value: "Mon–Fri 9–6" });
    expect(validateSettingValue(strDef, "x".repeat(201))).toMatchObject({ ok: false });
    expect(validateSettingValue(strDef, { nested: true })).toMatchObject({ ok: false });
    expect(validateSettingValue(strDef, "token=abc123def456")).toMatchObject({ ok: false });
    expect(validateSettingValue(strDef, "sk-abcdef1234567890")).toMatchObject({ ok: false });
  });
});

/* ── Reads ───────────────────────────────────────────────────────────────── */

describe("listAppSettings / getAppSetting", () => {
  it("merges registry defaults when the store is empty", async () => {
    const { db } = fakeDb();
    const list = await listAppSettings(db);
    expect(list.configured).toBe(true);
    expect(list.storeAvailable).toBe(true);
    expect(list.settings).toHaveLength(APP_SETTING_REGISTRY.length);
    for (const s of list.settings) expect(s.isDefault).toBe(true);
    expect(list.settings.find((s) => s.key === "site.maintenance_mode")?.value).toBe(false);
  });

  it("reports storeAvailable=false honestly when the table read fails", async () => {
    const db = { from: () => { throw new Error("relation does not exist"); } } as unknown as SupabaseClient;
    const list = await listAppSettings(db);
    expect(list.configured).toBe(true);
    expect(list.storeAvailable).toBe(false);
    expect(list.settings.every((s) => s.isDefault)).toBe(true);
  });

  it("getAppSetting returns the stored value after a write", async () => {
    const { db } = fakeDb();
    await setAppSetting(db, ACTOR, USER, { key: "support.public_hours", value: "24/7" });
    const got = await getAppSetting(db, "support.public_hours");
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.setting.value).toBe("24/7");
      expect(got.setting.isDefault).toBe(false);
    }
    const missing = await getAppSetting(db, "nope.nope");
    expect(missing).toMatchObject({ ok: false, status: 400 });
  });
});

/* ── Writes ──────────────────────────────────────────────────────────────── */

describe("setAppSetting", () => {
  it("rejects arbitrary and secret-looking keys", async () => {
    const { db } = fakeDb();
    for (const key of ["admin.password", "totally.made_up", "stripe.secret_key", "x".repeat(200)]) {
      const res = await setAppSetting(db, ACTOR, USER, { key, value: true });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(400);
    }
  });

  it("rejects secret-looking values and wrong kinds", async () => {
    const { db } = fakeDb();
    const res1 = await setAppSetting(db, ACTOR, USER, { key: "newsletter.footer_text", value: "api_key=sk_live_abcdef123456" });
    expect(res1).toMatchObject({ ok: false, status: 400 });
    const res2 = await setAppSetting(db, ACTOR, USER, { key: "analytics.enabled", value: "yes" });
    expect(res2).toMatchObject({ ok: false, status: 400 });
    const res3 = await setAppSetting(db, ACTOR, USER, { key: "support.public_hours", value: 42 });
    expect(res3).toMatchObject({ ok: false, status: 400 });
  });

  it("writes a low-risk setting + audit event", async () => {
    const { db, tables } = fakeDb({ system_app_settings: [], system_audit_events: [] });
    const res = await setAppSetting(db, ACTOR, USER, { key: "maintenance.notice_enabled", value: true, environment: "production" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.setting.value).toBe(true);
      expect(res.setting.isDefault).toBe(false);
      expect(res.setting.risk).toBe("low");
    }
    const row = tables.system_app_settings.find((r) => r.key === "maintenance.notice_enabled");
    expect(row?.value).toBe(true);
    expect(row?.updated_by).toBe("user-1");
    const audit = auditRows(tables).find((r) => r.action === "app_setting.updated");
    expect(audit).toBeTruthy();
    expect(audit?.resource).toBe("app_setting:maintenance.notice_enabled");
    // Upsert semantics: a second write updates the same row, not a duplicate.
    await setAppSetting(db, ACTOR, USER, { key: "maintenance.notice_enabled", value: false });
    expect(tables.system_app_settings.filter((r) => r.key === "maintenance.notice_enabled")).toHaveLength(1);
    expect(tables.system_app_settings[0].value).toBe(false);
  });

  it("enforces elevation for high-risk settings", async () => {
    const { db, tables } = fakeDb({ system_app_settings: [], system_audit_events: [], system_elevations: [] });
    // No elevation → 403 step_up_required, nothing written.
    const denied = await setAppSetting(db, ACTOR, USER, { key: "site.maintenance_mode", value: true });
    expect(denied).toMatchObject({ ok: false, status: 403, code: "step_up_required" });
    expect(tables.system_app_settings).toHaveLength(0);

    // Fresh elevation → write succeeds.
    tables.system_elevations.push(elevationRow());
    const allowed = await setAppSetting(db, ACTOR, USER, { key: "site.maintenance_mode", value: true });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.setting.value).toBe(true);

    // Stale elevation (expired) → denied again.
    tables.system_app_settings.length = 0;
    tables.system_elevations[0].expires_at = iso(-1000);
    tables.system_elevations[0].created_at = iso(-20 * 60_000);
    const stale = await setAppSetting(db, ACTOR, USER, { key: "site.maintenance_mode", value: true });
    expect(stale).toMatchObject({ ok: false, status: 403, code: "step_up_required" });
  });

  it("returns 503 when the backend is not configured", async () => {
    const res = await setAppSetting(null, ACTOR, USER, { key: "analytics.enabled", value: true });
    expect(res).toMatchObject({ ok: false, status: 503 });
  });
});
