import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getDatabaseAdmin, summarizeRowEstimates, getRowEstimates, getFreshness,
  FRESHNESS_TARGETS, STORAGE_GROWTH_STATE, ESTIMATE_TABLE_LIMIT,
  type RowEstimate,
} from "@/lib/system/db-admin";
import {
  getBackupPosture, ISOLATED_RESTORE_RUNBOOK, INDEPENDENT_BACKUP_STRATEGY,
  RESTORE_RUNBOOK,
} from "@/lib/system/recovery";
import {
  secretInventory, classifySecret, assertInventoryRedacted,
  POST_ROTATION_CHECKLIST, SECRET_EXPIRY_NOTE, SECRET_SCOPE_NOTE,
} from "@/lib/system/secrets";
import { roleCan } from "@/lib/system/rbac";
import { ACCOUNT_TOOLS, ACCOUNT_TOOL_NAMES } from "@/lib/ai/account-tools";

/* ── Minimal Supabase stub (same shape as system-recovery.test.ts) ──────── */

type Result = { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null };

function fakeTable(selectResult: Result = { data: [], error: null }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "filter", "update", "upsert", "delete", "insert", "eq"]) {
    b[m] = () => b;
  }
  b.limit = () => b;
  b.single = async () => ({ data: null, error: null });
  b.maybeSingle = async () => ({ data: null, error: null });
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(selectResult).then(res, rej);
  return b;
}

function fakeDb(tables: Record<string, Result>) {
  return {
    from: (t: string) => {
      const r = tables[t];
      if (!r) return fakeTable({ data: null, error: { message: `relation "${t}" does not exist` } });
      // select() carries {count, head} options for estimate probes — the stub
      // ignores them and returns the canned result either way.
      return fakeTable(r);
    },
  } as unknown as SupabaseClient;
}

/* ── db-admin: row estimates ───────────────────────────────────────────── */

describe("summarizeRowEstimates", () => {
  const rows: RowEstimate[] = [
    { table: "a", estimate: 100 },
    { table: "b", estimate: 50 },
    { table: "c", estimate: null, error: "42P01" },
  ];

  it("marks partial when some probes fail — never fabricates", () => {
    const s = summarizeRowEstimates(rows);
    expect(s.status).toBe("partial");
    expect(s.tablesProbed).toBe(3);
    expect(s.tablesWithEstimate).toBe(2);
    expect(s.estimatedTotalRows).toBe(150);
    expect(s.largest[0]).toEqual({ table: "a", estimate: 100 });
  });

  it("ok when all probes return estimates; unavailable when none do", () => {
    expect(summarizeRowEstimates([{ table: "a", estimate: 1 }]).status).toBe("ok");
    expect(summarizeRowEstimates([{ table: "a", estimate: null, error: "x" }]).status).toBe("unavailable");
    expect(summarizeRowEstimates([]).status).toBe("unavailable");
    expect(summarizeRowEstimates([]).estimatedTotalRows).toBeNull();
  });

  it("caps the probe list at ESTIMATE_TABLE_LIMIT", () => {
    expect(ESTIMATE_TABLE_LIMIT).toBeGreaterThan(0);
    expect(ESTIMATE_TABLE_LIMIT).toBeLessThanOrEqual(100);
  });
});

describe("getRowEstimates / getFreshness", () => {
  it("returns per-table estimates and per-table errors honestly", async () => {
    const db = fakeDb({
      rentals: { data: null, error: null, count: 1200 },
      payments: { data: null, error: { message: "boom", code: "XX" }, count: null },
    });
    const rows = await getRowEstimates(db, ["rentals", "payments", "missing_table"]);
    expect(rows.find((r) => r.table === "rentals")?.estimate).toBe(1200);
    expect(rows.find((r) => r.table === "payments")?.estimate).toBeNull();
    expect(rows.find((r) => r.table === "missing_table")?.estimate).toBeNull();
  });

  it("freshness returns newest timestamp or honest empty/failed states", async () => {
    const db = fakeDb({
      cron_runs: { data: [{ ran_at: "2026-01-01T00:00:00Z" }], error: null },
      app_logs: { data: [], error: null },
    });
    const rows = await getFreshness(db);
    const cron = rows.find((r) => r.table === "cron_runs");
    expect(cron?.lastAt).toBe("2026-01-01T00:00:00Z");
    expect(cron?.probed).toBe(true);
    const logs = rows.find((r) => r.table === "app_logs");
    expect(logs?.lastAt).toBeNull();
    expect(logs?.probed).toBe(true); // probed, just empty
    const audit = rows.find((r) => r.table === "system_audit_events");
    expect(audit?.probed).toBe(false); // table missing in stub → honest failure
  });

  it("freshness targets use real timestamp columns from migrations", () => {
    // Whitelist sanity: every target names a column that exists in migrations.
    const migrations = ["0008_ops_tooling.sql", "0023_inbound_jobs.sql", "0026_observability.sql", "0042_system_control.sql", "0045_system_ops.sql", "0010_payments.sql", "0001_init.sql", "0029_intelligence.sql", "0004_helpdesk.sql"];
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const all = migrations.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    for (const t of FRESHNESS_TARGETS) {
      expect(all, `${t.table}.${t.column}`).toContain(t.column);
    }
  });
});

describe("getDatabaseAdmin — new honest states", () => {
  it("null db: estimates/freshness empty, catalog probes unavailable, storage no_history", async () => {
    const r = await getDatabaseAdmin(null);
    expect(r.rowEstimates).toBeNull();
    expect(r.freshness).toEqual([]);
    expect(r.tableSizes.status).toBe("unavailable");
    expect(r.indexUsage.status).toBe("unavailable");
    expect(r.storageGrowth.status).toBe("no_history");
    expect(r.storageGrowth.note).toMatch(/no recorded history|no_history/i);
    expect(r.reachable).toBe(false);
  });

  it("RLS coverage derives a real percentage from the repo scan", async () => {
    const r = await getDatabaseAdmin(null); // repo scan needs no DB
    if (r.rls.status !== "scanned") throw new Error("expected scanned RLS coverage");
    expect(r.rls.manifestTables).toBeGreaterThan(0);
    const pct = Math.round((r.rls.rlsEnabledTables / r.rls.manifestTables) * 100);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
    // uncovered list must be consistent with the counts
    expect(r.rls.uncoveredTables.length).toBeLessThanOrEqual(r.rls.manifestTables);
  });
});

/* ── recovery: backup posture honesty ──────────────────────────────────── */

describe("getBackupPosture", () => {
  const testRow = (result: string, tested_at: string) => ({
    id: `t-${tested_at}`, tested_at, environment: "isolated-project",
    method: "supabase_backup_restore", result, rpo_minutes: 30, rto_minutes: 90,
    notes: null, actor_id: null, created_at: tested_at,
  });

  it("no tests + snapshot (walg on, pitr off, 0 backups) → no_verified_backup", async () => {
    const db = fakeDb({ system_recovery_tests: { data: [], error: null } });
    const p = await getBackupPosture(db);
    expect(p.state).toBe("no_verified_backup");
    expect(p.snapshotIsLive).toBe(false);
    expect(p.providerSnapshot.as_of).toBeTruthy();
    expect(p.testsTotal).toBe(0);
    expect(p.testsPassed).toBe(0);
    expect(p.lastTest).toBeNull();
  });

  it("a passed test → restore_tested (self-reported, never recovery_verified)", async () => {
    const db = fakeDb({
      system_recovery_tests: {
        data: [testRow("passed", "2026-02-01T00:00:00Z"), testRow("failed", "2026-01-01T00:00:00Z")],
        error: null,
      },
    });
    const p = await getBackupPosture(db);
    expect(p.state).toBe("restore_tested");
    expect(p.state).not.toBe("recovery_verified");
    expect(p.testsTotal).toBe(2);
    expect(p.testsPassed).toBe(1);
    expect(p.lastTest?.result).toBe("passed");
  });

  it("tests present but none passed → restore_pending", async () => {
    const db = fakeDb({ system_recovery_tests: { data: [testRow("failed", "2026-01-01T00:00:00Z")], error: null } });
    const p = await getBackupPosture(db);
    expect(p.state).toBe("restore_pending");
  });

  it("null db → honest posture with null test counts, never throws", async () => {
    const p = await getBackupPosture(null);
    expect(p.testsTotal).toBeNull();
    expect(p.testsPassed).toBeNull();
    expect(p.snapshotIsLive).toBe(false);
    expect(typeof p.state).toBe("string");
  });
});

describe("isolated restore runbook + backup strategy docs", () => {
  it("isolated runbook ends with record-then-destroy and carries warnings", () => {
    expect(ISOLATED_RESTORE_RUNBOOK.length).toBeGreaterThanOrEqual(5);
    const last = ISOLATED_RESTORE_RUNBOOK[ISOLATED_RESTORE_RUNBOOK.length - 1];
    expect(last.detail).toMatch(/destroy|delete/i);
    expect(ISOLATED_RESTORE_RUNBOOK.filter((s) => s.warning).length).toBeGreaterThanOrEqual(1);
    expect(ISOLATED_RESTORE_RUNBOOK.some((s) => /preview/i.test(s.detail))).toBe(true);
    expect(ISOLATED_RESTORE_RUNBOOK.some((s) => /migration/i.test(s.detail))).toBe(true);
  });

  it("independent backup strategy is entirely UNVERIFIED and covers key separation", () => {
    expect(INDEPENDENT_BACKUP_STRATEGY.length).toBeGreaterThanOrEqual(5);
    for (const s of INDEPENDENT_BACKUP_STRATEGY) expect(s.status).toBe("unverified");
    const all = INDEPENDENT_BACKUP_STRATEGY.map((s) => `${s.title} ${s.detail}`).join(" ");
    expect(all).toMatch(/encrypt/i);
    expect(all).toMatch(/DEVICE_CREDENTIAL_KEK|key separation|separate from/i);
    expect(all).toMatch(/retention/i);
    expect(all).toMatch(/monitor|heartbeat/i);
    expect(all).toMatch(/restore.test|drill/i);
  });

  it("base runbook still warns against blind production restores", () => {
    expect(RESTORE_RUNBOOK.some((s) => s.warning && /never restore over production/i.test(`${s.title} ${s.detail}`))).toBe(true);
  });
});

/* ── secrets: inventory redaction + classification + authorization ─────── */

describe("secret inventory", () => {
  it("classifies credential / config / publishable correctly", () => {
    expect(classifySecret({ envVar: "STRIPE_SECRET_KEY", purpose: "", rotation: "Roll key" })).toBe("credential");
    expect(classifySecret({ envVar: "STRIPE_TAX_ENABLED", purpose: "", rotation: "Not a secret — set to 1" })).toBe("config");
    expect(classifySecret({ envVar: "NEXT_PUBLIC_SUPABASE_URL", purpose: "", rotation: "x" })).toBe("publishable");
    expect(classifySecret({ envVar: "NEXT_PUBLIC_SUPABASE_ANON_KEY", purpose: "", rotation: "x" })).toBe("publishable");
  });

  it("never leaks env values — JSON contains no configured secret material", async () => {
    const sentinel = "TESTSECRET_SENTINEL_12345";
    const prev = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = sentinel;
    try {
      const rows = await secretInventory(null);
      const json = JSON.stringify(rows);
      expect(json).not.toContain(sentinel);
      expect(json).not.toContain('"value"');
      expect(json).not.toContain('"new_value"');
      const stripe = rows.find((r) => r.envVar === "STRIPE_SECRET_KEY");
      expect(stripe?.configured).toBe(true);
      expect(stripe?.sensitivity).toBe("credential");
      expect(stripe?.rotationState).toBe("never_requested"); // null db → no audit rows
      expect(stripe?.expiryTracking).toBe("none");
      expect(stripe?.scopeNote).toBe(SECRET_SCOPE_NOTE);
    } finally {
      if (prev === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prev;
    }
  });

  it("assertInventoryRedacted passes real rows and fails rows carrying value keys", async () => {
    const rows = (await secretInventory(null)) as unknown as Record<string, unknown>[];
    expect(assertInventoryRedacted(rows)).toEqual({ ok: true });
    expect(assertInventoryRedacted([{ envVar: "X", value: "leak" }])).toMatchObject({ ok: false });
    expect(assertInventoryRedacted([{ envVar: "X", api_key: "leak" }])).toMatchObject({ ok: false });
  });

  it("scope + expiry are honest: no per-env scope claim, no fake expiry", () => {
    expect(SECRET_SCOPE_NOTE).toMatch(/cannot read|current runtime/i);
    expect(SECRET_EXPIRY_NOTE).toMatch(/no expiry|cannot be computed/i);
    expect(POST_ROTATION_CHECKLIST.length).toBeGreaterThanOrEqual(4);
    expect(POST_ROTATION_CHECKLIST.join(" ")).toMatch(/revoke|expire the OLD/i);
  });

  it("rotation permission is restricted: viewer denied, security/sysadmin allowed", () => {
    expect(roleCan("viewer", "system.secrets.rotate")).toBe(false);
    expect(roleCan("developer", "system.secrets.rotate")).toBe(false);
    expect(roleCan("engineer", "system.secrets.rotate")).toBe(false);
    expect(roleCan("hardware", "system.secrets.rotate")).toBe(false);
    expect(roleCan("security", "system.secrets.rotate")).toBe(true);
    expect(roleCan("sysadmin", "system.secrets.rotate")).toBe(true);
    expect(roleCan("breakglass", "system.secrets.rotate")).toBe(true);
  });

  it("rotate route source enforces perm + step-up elevation + change approval", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/app/api/system/secrets/rotate/route.ts"), "utf8",
    );
    expect(src).toContain('systemApiGuard("system.secrets.rotate"');
    expect(src).toContain("requireElevation");
    expect(src).toContain("assertApprovedOrRequest");
    expect(src).toContain('risk: "high"');
  });

  it("no AI tool can reach secrets/env — tool names are a fixed allowlist", () => {
    const names = [...ACCOUNT_TOOL_NAMES, ...ACCOUNT_TOOLS.map((t) => t.function.name)];
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(n).not.toMatch(/secret|env|credential|rotation|token|key/i);
    }
    // The customer assistant's public tools are module-private; scan source.
    const assistantSrc = readFileSync(path.join(process.cwd(), "src/lib/ai/assistant.ts"), "utf8");
    const toolNames = [...assistantSrc.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]);
    expect(toolNames.length).toBeGreaterThan(0);
    for (const n of toolNames) {
      expect(n).not.toMatch(/secret|env_|credential|rotation|token|api_key/i);
    }
    // No AI module may import the secrets registry or env-diagnostics values.
    for (const f of ["src/lib/ai/assistant.ts", "src/lib/ai/account-tools.ts", "src/lib/system/ai.ts", "src/lib/system/ai-ops.ts", "src/lib/system/ai-extra.ts"]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/from ["'].*system\/secrets["']/);
      expect(src, f).not.toMatch(/SECRET_REGISTRY|SECRET_BY_ENV_VAR/);
    }
  });
});
