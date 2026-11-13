import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildAdminChecklist,
  securityReadiness,
  type AdminChecklistInput,
} from "@/lib/system/readiness";

/* ── Minimal Supabase stub (same shape as system-readiness-alerts.test.ts) ── */

type Call = [string, ...unknown[]];
type Result = { data?: unknown; error?: { message: string } | null };

function fakeTable(
  opts: { count?: number | ((calls: Call[]) => number); single?: Result } = {},
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

const ENV_KEY = "SYSTEM_BOOTSTRAP_TOKEN";
let savedToken: string | undefined;
beforeEach(() => { savedToken = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
afterEach(() => {
  if (savedToken === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedToken;
});

const baseInput = (over: Partial<AdminChecklistInput> = {}): AdminChecklistInput => ({
  bootstrapTokenConfigured: false,
  systemRoleProfiles: 0,
  bootstrapGrants: 0,
  mfaEnrollAudits: 0,
  mfaVerifyAudits: 0,
  totpElevations: 0,
  sessionRevocations: 0,
  ...over,
});

const item = (items: ReturnType<typeof buildAdminChecklist>, id: string) => {
  const it = items.find((i) => i.id === id);
  expect(it, `checklist item ${id}`).toBeDefined();
  return it!;
};

/* ── buildAdminChecklist (pure) ────────────────────────────────────────── */

describe("buildAdminChecklist", () => {
  it("fresh state: token blocked, redirect/manual items pending, nothing verified", () => {
    const items = buildAdminChecklist(baseInput());
    expect(items.map((i) => i.id)).toEqual([
      "bootstrap_token", "supabase_redirect_url", "first_admin_role",
      "totp_enrolled", "mfa_verify_tested", "step_up_elevation",
      "session_expiration", "session_revocation_tested", "access_control_tests",
    ]);
    expect(item(items, "bootstrap_token").status).toBe("blocked");
    expect(item(items, "supabase_redirect_url").status).toBe("pending_manual");
    expect(item(items, "first_admin_role").status).toBe("blocked");
    expect(item(items, "totp_enrolled").status).toBe("pending_manual");
    expect(item(items, "mfa_verify_tested").status).toBe("pending_manual");
    expect(item(items, "step_up_elevation").status).toBe("pending_manual");
    expect(item(items, "session_revocation_tested").status).toBe("pending_manual");
    expect(item(items, "access_control_tests").status).toBe("pending_manual");
  });

  it("session expiration is the ONLY unconditional code-verified item", () => {
    const items = buildAdminChecklist(baseInput());
    const verified = items.filter((i) => i.status === "verified_by_code").map((i) => i.id);
    expect(verified).toEqual(["session_expiration"]);
    expect(item(items, "session_expiration").evidence).toMatch(/24h|SESSION_MAX_AGE_MS/);
  });

  it("bootstrap token env flips item 1 to verified_by_code and unblocks role grant path", () => {
    const items = buildAdminChecklist(baseInput({ bootstrapTokenConfigured: true }));
    expect(item(items, "bootstrap_token").status).toBe("verified_by_code");
    // Token set but no grant yet → pending_manual with bootstrap instructions.
    const role = item(items, "first_admin_role");
    expect(role.status).toBe("pending_manual");
    expect(role.action).toContain("/system/security/bootstrap");
  });

  it("system_role grant or bootstrap grant row → first_admin_role verified_by_code", () => {
    expect(item(buildAdminChecklist(baseInput({ systemRoleProfiles: 1 })), "first_admin_role").status).toBe("verified_by_code");
    expect(item(buildAdminChecklist(baseInput({ bootstrapGrants: 1 })), "first_admin_role").status).toBe("verified_by_code");
  });

  it("null counts → blocked, never fabricated", () => {
    const items = buildAdminChecklist(baseInput({ systemRoleProfiles: null, bootstrapGrants: null }));
    expect(item(items, "first_admin_role").status).toBe("blocked");
    expect(item(items, "first_admin_role").evidence).toMatch(/unavailable|unknown/i);
  });

  it("mfa.totp.verified audit rows prove enrollment + verify + elevation honestly", () => {
    const items = buildAdminChecklist(baseInput({ mfaVerifyAudits: 2, totpElevations: 1 }));
    expect(item(items, "totp_enrolled").status).toBe("verified_by_code");
    expect(item(items, "mfa_verify_tested").status).toBe("verified_by_code");
    expect(item(items, "step_up_elevation").status).toBe("verified_by_code");
    expect(item(items, "totp_enrolled").evidence).toMatch(/verified TOTP factor necessarily exists/);
  });

  it("enroll.started alone does NOT prove a verified factor", () => {
    const items = buildAdminChecklist(baseInput({ mfaEnrollAudits: 3 }));
    expect(item(items, "totp_enrolled").status).toBe("pending_manual");
    expect(item(items, "totp_enrolled").evidence).toMatch(/never completed/);
  });

  it("MANUAL ITEMS NEVER AUTO-PASS — even with recorded revocation audits", () => {
    const items = buildAdminChecklist(baseInput({
      bootstrapTokenConfigured: true,
      systemRoleProfiles: 1,
      bootstrapGrants: 1,
      mfaVerifyAudits: 5,
      totpElevations: 3,
      sessionRevocations: 4,
    }));
    // Everything provable is verified…
    for (const id of ["bootstrap_token", "first_admin_role", "totp_enrolled", "mfa_verify_tested", "step_up_elevation", "session_expiration"]) {
      expect(item(items, id).status, id).toBe("verified_by_code");
    }
    // …but dashboard-side + attestation items stay pending_manual FOREVER.
    expect(item(items, "supabase_redirect_url").status).toBe("pending_manual");
    expect(item(items, "session_revocation_tested").status).toBe("pending_manual");
    expect(item(items, "access_control_tests").status).toBe("pending_manual");
    // Evidence still surfaces the recorded revocations honestly.
    expect(item(items, "session_revocation_tested").evidence).toContain("4");
  });
});

/* ── securityReadiness integration ─────────────────────────────────────── */

describe("securityReadiness — admin_checklist", () => {
  /** DB where every count resolves via the per-table resolver. */
  const dbWith = (tables: Record<string, ReturnType<typeof fakeTable>>) => fakeDb(tables);

  it("populates admin_checklist from live counts + env", async () => {
    process.env[ENV_KEY] = "tok";
    const db = dbWith({
      profiles: fakeTable({
        count: (calls) => (hasCall(calls, "not", "system_role", "is", null) ? 1 : 0),
      }),
      system_bootstrap_grants: fakeTable({ count: 1 }),
      system_elevations: fakeTable({
        count: (calls) => (hasCall(calls, "eq", "method", "totp") ? 2 : 0),
      }),
      system_audit_events: fakeTable({
        count: (calls) =>
          hasCall(calls, "eq", "action", "mfa.totp.verified") ? 3
          : hasCall(calls, "eq", "action", "mfa.enroll.started") ? 1
          : hasCall(calls, "in", "action", ["session.revoked", "session.revoked_all"]) ? 2
          : 0,
      }),
    });
    const r = await securityReadiness(db);
    expect(r.admin_checklist.length).toBe(9);
    const byId = Object.fromEntries(r.admin_checklist.map((i) => [i.id, i.status]));
    expect(byId.bootstrap_token).toBe("verified_by_code");
    expect(byId.first_admin_role).toBe("verified_by_code");
    expect(byId.totp_enrolled).toBe("verified_by_code");
    expect(byId.mfa_verify_tested).toBe("verified_by_code");
    expect(byId.step_up_elevation).toBe("verified_by_code");
    expect(byId.session_expiration).toBe("verified_by_code");
    expect(byId.supabase_redirect_url).toBe("pending_manual");
    expect(byId.session_revocation_tested).toBe("pending_manual");
    expect(byId.access_control_tests).toBe("pending_manual");
  });

  it("empty DB (all counts 0, no token) → honest pending/blocked, no verified except code item", async () => {
    const r = await securityReadiness(fakeDb({}));
    const byId = Object.fromEntries(r.admin_checklist.map((i) => [i.id, i.status]));
    expect(byId.bootstrap_token).toBe("blocked");
    expect(byId.session_expiration).toBe("verified_by_code");
    const verified = r.admin_checklist.filter((i) => i.status === "verified_by_code").map((i) => i.id);
    expect(verified).toEqual(["session_expiration"]);
  });

  it("null db → checklist still renders env-based items honestly", async () => {
    const r = await securityReadiness(null);
    expect(r.configured).toBe(false);
    expect(r.admin_checklist.length).toBe(9);
    const byId = Object.fromEntries(r.admin_checklist.map((i) => [i.id, i.status]));
    expect(byId.bootstrap_token).toBe("blocked"); // env unset in test
    expect(byId.first_admin_role).toBe("blocked"); // counts null
    expect(byId.supabase_redirect_url).toBe("pending_manual");
  });
});
