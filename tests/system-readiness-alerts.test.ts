import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveBackupState,
  securityReadiness,
  LAST_KNOWN_PROVIDER_SNAPSHOT,
  type ProviderBackupSnapshot,
} from "@/lib/system/readiness";
import { ALERT_POLICY } from "@/lib/system/obs-extra";

/* ── Minimal Supabase stub (same shape as tests/system-recovery.test.ts) ── */

type Call = [string, ...unknown[]];
type Result = { data?: unknown; error?: { message: string } | null };

function fakeTable(
  opts: {
    /** Fixed count, or a resolver seeing the recorded filter chain. */
    count?: number | ((calls: Call[]) => number);
    single?: Result;
  } = {},
) {
  const calls: Call[] = [];
  const b: Record<string, unknown> = {};
  const chain =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return b;
    };
  for (const m of [
    "select", "eq", "neq", "in", "is", "not", "order", "lt", "lte",
    "gte", "gt", "ilike", "like", "filter", "update", "upsert", "delete", "limit",
  ]) {
    b[m] = chain(m);
  }
  b.insert = (...a: unknown[]) => {
    calls.push(["insert", ...a]);
    return b;
  };
  b.single = async () => opts.single ?? { data: null, error: null };
  b.maybeSingle = async () => opts.single ?? { data: null, error: null };
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => {
    const count = typeof opts.count === "function" ? opts.count(calls) : (opts.count ?? 0);
    return Promise.resolve({ count, data: [], error: null }).then(res, rej);
  };
  return b;
}

function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}

const hasCall = (calls: Call[], name: string, ...args: unknown[]) =>
  calls.some((c) => c[0] === name && args.every((a, i) => c[i + 1] === a));

/** Default DB: zero rows everywhere except configurable recovery/change tables. */
function defaultDb(over: {
  recoveryTotal?: number;
  recoveryPassed?: number;
  recoveryRow?: Result;
  retentionApprovals?: number;
  bootstrapGrants?: number;
} = {}) {
  return fakeDb({
    system_recovery_tests: fakeTable({
      count: (calls) =>
        hasCall(calls, "eq", "result", "passed") ? (over.recoveryPassed ?? 0) : (over.recoveryTotal ?? 0),
      single: over.recoveryRow ?? { data: null, error: null },
    }),
    system_retention_runs: fakeTable(),
    system_change_requests: fakeTable({
      count: (calls) =>
        hasCall(calls, "eq", "status", "pending") && hasCall(calls, "ilike", "action", "retention%")
          ? (over.retentionApprovals ?? 0)
          : 0,
    }),
    system_bootstrap_grants: fakeTable({ count: over.bootstrapGrants ?? 0 }),
  });
}

const snap = (over: Partial<ProviderBackupSnapshot> = {}): ProviderBackupSnapshot => ({
  ...LAST_KNOWN_PROVIDER_SNAPSHOT,
  ...over,
});

/* ── deriveBackupState: every transition ────────────────────────────────── */

describe("deriveBackupState", () => {
  it("no_verified_backup — empty snapshot, no PITR, no backups, no tests", () => {
    expect(deriveBackupState({ pitrEnabled: false, backupCount: 0 })).toBe("no_verified_backup");
    expect(deriveBackupState({})).toBe("no_verified_backup");
    expect(deriveBackupState({ pitrEnabled: null, backupCount: null })).toBe("no_verified_backup");
  });

  it("backup_configured — PITR enabled but no listed backup entries", () => {
    expect(deriveBackupState({ pitrEnabled: true, backupCount: 0 })).toBe("backup_configured");
  });

  it("backup_available — provider listed backup entries", () => {
    expect(deriveBackupState({ pitrEnabled: false, backupCount: 3 })).toBe("backup_available");
    expect(deriveBackupState({ pitrEnabled: true, backupCount: 2 })).toBe("backup_available");
  });

  it("restore_pending — recovery tests exist but none passed", () => {
    expect(deriveBackupState({ pitrEnabled: true, backupCount: 5, recoveryTests: 1, recoveryPassed: false })).toBe("restore_pending");
  });

  it("restore_tested — a passed recovery test outranks backup states", () => {
    expect(deriveBackupState({ pitrEnabled: false, backupCount: 0, recoveryTests: 2, recoveryPassed: true })).toBe("restore_tested");
  });

  it("recovery_verified — ONLY via explicit verified marker", () => {
    expect(deriveBackupState({ recoveryVerifiedRecorded: true })).toBe("recovery_verified");
    // A passed test alone is NOT enough — still self-reported restore_tested.
    expect(deriveBackupState({ recoveryTests: 1, recoveryPassed: true, recoveryVerifiedRecorded: false })).toBe("restore_tested");
  });
});

/* ── securityReadiness integration ──────────────────────────────────────── */

describe("securityReadiness — backup state + snapshot", () => {
  it("default snapshot derives no_verified_backup and is labeled with as_of", async () => {
    const r = await securityReadiness(defaultDb());
    expect(r.backup.state).toBe("no_verified_backup");
    expect(r.backup.provider_snapshot?.as_of).toBe(LAST_KNOWN_PROVIDER_SNAPSHOT.as_of);
    expect(r.backup.provider_snapshot?.source).toBe("supabase_cli");
    const section = r.sections.find((s) => s.id === "backups_pitr");
    expect(section?.detail).toContain(`state=no_verified_backup`);
    expect(section?.detail).toContain(`as_of ${LAST_KNOWN_PROVIDER_SNAPSHOT.as_of}`);
    expect(section?.status).toBe("unverified");
  });

  it("injected PITR snapshot advances to backup_configured", async () => {
    const r = await securityReadiness(defaultDb(), {
      providerSnapshot: snap({ pitr_enabled: true, backup_count: 0 }),
    });
    expect(r.backup.state).toBe("backup_configured");
  });

  it("injected backup entries advance to backup_available", async () => {
    const r = await securityReadiness(defaultDb(), {
      providerSnapshot: snap({ backup_count: 7 }),
    });
    expect(r.backup.state).toBe("backup_available");
  });

  it("passed recovery test advances to restore_tested", async () => {
    const r = await securityReadiness(
      defaultDb({
        recoveryTotal: 2,
        recoveryPassed: 1,
        recoveryRow: {
          data: { result: "passed", tested_at: "2026-11-01T00:00:00Z", environment: "isolated-project" },
          error: null,
        },
      }),
    );
    expect(r.backup.state).toBe("restore_tested");
    expect(r.backup.state).not.toBe("recovery_verified");
    const drill = r.sections.find((s) => s.id === "recovery_drill");
    expect(drill?.status).toBe("test_verified");
    expect(drill?.detail).toMatch(/self-reported|manually entered/i);
  });

  it("unpassed recovery tests derive restore_pending", async () => {
    const r = await securityReadiness(
      defaultDb({
        recoveryTotal: 1,
        recoveryPassed: 0,
        recoveryRow: { data: { result: "partial", tested_at: "2026-11-01T00:00:00Z", environment: "isolated-project" }, error: null },
      }),
    );
    expect(r.backup.state).toBe("restore_pending");
  });

  it("live probe can NEVER emit recovery_verified (no verified column exists)", async () => {
    const r = await securityReadiness(
      defaultDb({ recoveryTotal: 5, recoveryPassed: 5 }),
    );
    expect(r.backup.state).not.toBe("recovery_verified");
    expect(r.backup.state).toBe("restore_tested");
  });

  it("null provider snapshot is honest — no_verified_backup + note", async () => {
    const r = await securityReadiness(defaultDb(), { providerSnapshot: null });
    expect(r.backup.state).toBe("no_verified_backup");
    expect(r.backup.provider_snapshot).toBeNull();
    expect(r.notes.some((n) => /no provider backup snapshot/i.test(n))).toBe(true);
  });
});

/* ── Admin activation (bootstrap) probe ─────────────────────────────────── */

describe("admin activation section", () => {
  it("exists and reflects the single-grant constraint", async () => {
    const r0 = await securityReadiness(defaultDb({ bootstrapGrants: 0 }));
    const s0 = r0.sections.find((s) => s.id === "admin_activation");
    expect(s0).toBeDefined();
    expect(s0?.detail).toMatch(/awaiting first-admin enrollment/i);
    expect(s0?.detail).toMatch(/at most ONE|caps grants at ONE/i);
    expect(s0?.status).toBe("unverified");

    const r1 = await securityReadiness(defaultDb({ bootstrapGrants: 1 }));
    const s1 = r1.sections.find((s) => s.id === "admin_activation");
    expect(s1?.detail).toMatch(/activation is complete/i);
    expect(s1?.status).toBe("configured");
  });
});

/* ── Pending retention approvals still counted ──────────────────────────── */

describe("pending retention approvals", () => {
  it("counts pending retention% change requests honestly", async () => {
    const r = await securityReadiness(defaultDb({ retentionApprovals: 4 }));
    expect(r.pending_retention_approvals).toBe(4);
    const section = r.sections.find((s) => s.id === "retention_execute");
    expect(section?.status).toBe("blocked");
    expect(section?.detail).toContain("4");
  });

  it("zero pending approvals unblocks retention_execute reporting", async () => {
    const r = await securityReadiness(defaultDb({ retentionApprovals: 0 }));
    expect(r.pending_retention_approvals).toBe(0);
    expect(r.sections.find((s) => s.id === "retention_execute")?.status).toBe("unverified");
  });
});

/* ── ALERT_POLICY Phase 2.4 rules ───────────────────────────────────────── */

describe("ALERT_POLICY rules", () => {
  const ids = ALERT_POLICY.rules.map((r) => r.id);

  it("covers every required Phase 2.4 source", () => {
    expect(ids).toEqual(
      expect.arrayContaining([
        "kiosk.provisioning_failed_burst",
        "device.revoked_credential_attempts",
        "device.duplicate_message_burst",
        "device.offline_stale_heartbeat",
        "device.missing_dispense_ack",
        "rental.return_ack_mismatch",
        "rental.exceptions_unresolved",
        "finance.unresolved_settlement",
      ]),
    );
  });

  it("each rule carries severity, window and dedup", () => {
    for (const rule of ALERT_POLICY.rules) {
      expect(["sev1", "sev2", "sev3", "sev4"]).toContain(rule.severity);
      expect(rule.windowMinutes).toBeGreaterThan(0);
      expect(rule.dedup.length).toBeGreaterThan(0);
      expect(rule.source.length).toBeGreaterThan(0);
      expect(rule.match.length).toBeGreaterThan(0);
      expect(["live", "pending"]).toContain(rule.emitter);
    }
  });

  it("rental_exceptions + settlement rules are live via the cron alert sweep", () => {
    const rental = ALERT_POLICY.rules.find((r) => r.id === "rental.exceptions_unresolved");
    const settlement = ALERT_POLICY.rules.find((r) => r.id === "finance.unresolved_settlement");
    expect(rental?.emitter).toBe("live");
    expect(settlement?.emitter).toBe("live");
    expect(rental?.source).toMatch(/rental_exceptions/);
  });

  it("revoked-credential, duplicate-message and heartbeat rules are live signals", () => {
    for (const id of [
      "device.revoked_credential_attempts",
      "device.duplicate_message_burst",
      "device.offline_stale_heartbeat",
      "device.missing_dispense_ack",
      "rental.return_ack_mismatch",
    ]) {
      expect(ALERT_POLICY.rules.find((r) => r.id === id)?.emitter).toBe("live");
    }
  });

  it("policy notes keep the honesty caveat about pending emitters", () => {
    expect(ALERT_POLICY.notes.some((n) => /pending.*not coverage|declarative policy/i.test(n))).toBe(true);
  });
});
