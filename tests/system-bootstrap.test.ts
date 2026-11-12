import { describe, expect, it, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  attemptBootstrap, setSystemSuspended, revokeUserSessions, bootstrapTokenMatches,
} from "@/lib/system/identity";
import { roleGrantRisk } from "@/lib/system/security";
import type { SessionUser } from "@/lib/auth";
import type { MfaConfig } from "@/lib/system/mfa";

const CONFIG: MfaConfig = { url: "https://proj.supabase.co", anonKey: "anon-key" };
const TOKEN_ENV = "SYSTEM_BOOTSTRAP_TOKEN";
const user = (id = "u-new", email = "new@zapnivo.com"): SessionUser => ({ id, email, role: "staff", organizationId: null });

const fetchVerified = () =>
  (async () => ({
    ok: true, status: 200,
    json: async () => ({ all: [], totp: [{ id: "f1", factor_type: "totp", status: "verified" }], phone: [] }),
  }) as Response) as unknown as typeof fetch;
const fetchNoMfa = () =>
  (async () => ({
    ok: true, status: 200,
    json: async () => ({ all: [], totp: [{ id: "f1", factor_type: "totp", status: "unverified" }], phone: [] }),
  }) as Response) as unknown as typeof fetch;

type Result = { data?: unknown; error?: { message: string } | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown; _delete?: unknown } = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "insert", "update", "upsert", "delete", "filter"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "insert") b._insert = a[0];
      if (m === "update") b._update = a[0];
      if (m === "delete") b._delete = a[0];
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
  const db = { from: (t: string) => { calls.push(t); return tables[t] ?? fakeTable(); } } as unknown as SupabaseClient;
  return { db, calls };
}

const baseInput = { token: "sekrit-token", confirmEmail: "new@zapnivo.com", accessToken: "at" };
const deps = { config: CONFIG, fetchImpl: fetchVerified() };

afterEach(() => { delete process.env[TOKEN_ENV]; });

describe("attemptBootstrap", () => {
  it("503 bootstrap_not_configured when env token is unset", async () => {
    delete process.env[TOKEN_ENV];
    const { db } = fakeDb({});
    const res = await attemptBootstrap(db, user(), baseInput, deps);
    expect(res).toMatchObject({ ok: false, status: 503, code: "bootstrap_not_configured" });
  });

  it("403 on wrong token (constant-time compare)", async () => {
    process.env[TOKEN_ENV] = "right-token";
    expect(bootstrapTokenMatches("right-token", "right-token")).toBe(true);
    expect(bootstrapTokenMatches("wrong-token", "right-token")).toBe(false);
    expect(bootstrapTokenMatches("", "right-token")).toBe(false);
    const { db } = fakeDb({});
    const res = await attemptBootstrap(db, user(), { ...baseInput, token: "nope" }, deps);
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it("400 when confirm_email doesn't match session email", async () => {
    process.env[TOKEN_ENV] = "sekrit-token";
    const { db } = fakeDb({});
    const res = await attemptBootstrap(db, user(), { ...baseInput, confirmEmail: "other@zapnivo.com" }, deps);
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("403 mfa_enrollment_required without a verified TOTP factor", async () => {
    process.env[TOKEN_ENV] = "sekrit-token";
    const { db } = fakeDb({});
    const res = await attemptBootstrap(db, user(), baseInput, { config: CONFIG, fetchImpl: fetchNoMfa() });
    expect(res).toMatchObject({ ok: false, status: 403, code: "mfa_enrollment_required" });
  });

  it("409 replay denial when a bootstrap grant already exists", async () => {
    process.env[TOKEN_ENV] = "sekrit-token";
    const grants = fakeTable({ list: { data: [{ id: "g1" }] } });
    const { db, calls } = fakeDb({ system_bootstrap_grants: grants });
    const res = await attemptBootstrap(db, user(), baseInput, deps);
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(calls).not.toContain("profiles"); // denied before touching the profile
  });

  it("409 when the account already holds a system_role (never overwrites)", async () => {
    process.env[TOKEN_ENV] = "sekrit-token";
    const grants = fakeTable({ list: { data: [] } });
    const profiles = fakeTable({ singles: [{ data: { id: "u-new", system_role: "viewer" }, error: null }] });
    const { db } = fakeDb({ system_bootstrap_grants: grants, profiles });
    const res = await attemptBootstrap(db, user(), baseInput, deps);
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(profiles._update).toBeUndefined();
  });

  it("success: sets sysadmin only where NULL, writes grant row + audit", async () => {
    process.env[TOKEN_ENV] = "sekrit-token";
    const grants = fakeTable({
      list: { data: [] },
      singles: [{ data: null, error: null }],
    });
    // profiles: first maybeSingle → read {system_role:null}; second maybeSingle → update result {id}
    const profiles = fakeTable({
      singles: [
        { data: { id: "u-new", system_role: null }, error: null },
        { data: { id: "u-new" }, error: null },
      ],
    });
    const audit = fakeTable();
    const { db, calls } = fakeDb({ system_bootstrap_grants: grants, profiles, system_audit_events: audit });

    const res = await attemptBootstrap(db, user(), baseInput, deps);
    expect(res).toEqual({ ok: true });
    const upd = profiles._update as Record<string, unknown>;
    expect(upd.system_role).toBe("sysadmin");
    const grantInsert = grants._insert as Record<string, unknown>;
    expect(grantInsert.profile_id).toBe("u-new");
    expect(grantInsert.method).toBe("totp");
    expect(grantInsert.consumed_at).toBeTruthy(); // spent immediately
    const auditInsert = audit._insert as Record<string, unknown>;
    expect(auditInsert.action).toBe("system.bootstrap.grant");
    // TOTP secret / token material never lands in audit detail.
    expect(JSON.stringify(auditInsert)).not.toContain("sekrit-token");
    expect(calls).toContain("system_bootstrap_grants");
  });
});

describe("setSystemSuspended", () => {
  const actor = { id: "admin-1", role: "sysadmin" };

  it("blocks self-suspension", async () => {
    const { db, calls } = fakeDb({});
    const res = await setSystemSuspended(db, { ...actor, id: "u-self" }, "u-self", true);
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(calls).toHaveLength(0);
  });

  it("suspends + audits; unsuspend clears", async () => {
    const profiles = fakeTable({ singles: [{ data: { id: "u2", email: "t@x.com", system_suspended: false }, error: null }] });
    const audit = fakeTable();
    const { db } = fakeDb({ profiles, system_audit_events: audit });
    expect(await setSystemSuspended(db, actor, "u2", true)).toEqual({ ok: true });
    expect((profiles._update as Record<string, unknown>).system_suspended).toBe(true);
    expect((audit._insert as Record<string, unknown>).action).toBe("system_user.suspended");

    const profiles2 = fakeTable({ singles: [{ data: { id: "u2", email: "t@x.com", system_suspended: true }, error: null }] });
    const audit2 = fakeTable();
    const { db: db2 } = fakeDb({ profiles: profiles2, system_audit_events: audit2 });
    expect(await setSystemSuspended(db2, actor, "u2", false)).toEqual({ ok: true });
    expect((audit2._insert as Record<string, unknown>).action).toBe("system_user.unsuspended");
  });
});

describe("revokeUserSessions", () => {
  const actor = { id: "admin-1", role: "security" };

  it("blocks revoking ALL of your own sessions (use logout)", async () => {
    const { db, calls } = fakeDb({});
    const res = await revokeUserSessions(db, { ...actor, id: "me" }, "me");
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(calls).toHaveLength(0);
  });

  it("deletes auth_sessions rows for the target and audits", async () => {
    const sessions = fakeTable({ list: { data: [{ session_key: "sso:a" }, { session_key: "sso:b" }] } });
    const audit = fakeTable();
    const { db } = fakeDb({ auth_sessions: sessions, system_audit_events: audit });
    const res = await revokeUserSessions(db, actor, "u2");
    expect(res).toMatchObject({ ok: true, revoked: 2 });
    expect((audit._insert as Record<string, unknown>).action).toBe("session.revoked_all");
  });
});

describe("roleGrantRisk — sysadmin grants need approval like breakglass", () => {
  it("high for sysadmin/breakglass, medium otherwise, medium for revoke-of-null", () => {
    expect(roleGrantRisk("sysadmin")).toBe("high");
    expect(roleGrantRisk("breakglass")).toBe("high");
    expect(roleGrantRisk("security")).toBe("medium");
    expect(roleGrantRisk("viewer")).toBe("medium");
    expect(roleGrantRisk(null)).toBe("medium");
  });
});
