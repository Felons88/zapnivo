import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SYSTEM_PERMISSIONS, SYSTEM_ROLES, authorize, isSystemRole, mutationNeedsApproval,
  requireSystem, roleCan, ROLE_PERMISSIONS, systemRole,
  type SystemPermission, type SystemRole,
} from "@/lib/system/rbac";
import type { SessionUser } from "@/lib/auth";
import { planRoute } from "@/lib/subdomains";

const user = (id = "u1"): SessionUser => ({ id, email: "op@zapnivo.com", role: "staff", organizationId: null });

/** Minimal chainable Supabase stub: list result for awaited queries, queued results for single/maybeSingle. */
function fakeTable(opts: { list?: unknown; singles?: unknown[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> = {};
  const next = () => singles.length ? singles.shift() : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "insert", "update", "upsert", "delete", "filter"]) {
    b[m] = () => b;
  }
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(opts.list ?? { data: [], error: null, count: 0 }).then(res, rej);
  return b;
}
const dbWithRole = (role: string | null) =>
  ({ from: () => fakeTable({ singles: [{ data: role === null ? null : { system_role: role }, error: null }] }) }) as unknown as SupabaseClient;

describe("system role → permission matrix", () => {
  it("covers every declared role and permission", () => {
    for (const r of SYSTEM_ROLES) expect(ROLE_PERMISSIONS[r]).toBeDefined();
    for (const p of SYSTEM_PERMISSIONS) expect(typeof p).toBe("string");
  });

  it("viewer is read-only", () => {
    expect(roleCan("viewer", "system.dashboard.view")).toBe(true);
    expect(roleCan("viewer", "system.security.audit.view")).toBe(true);
    expect(roleCan("viewer", "system.flags.manage")).toBe(false);
    expect(roleCan("viewer", "system.kiosks.manage")).toBe(false);
    expect(roleCan("viewer", "system.secrets.rotate")).toBe(false);
    expect(roleCan("viewer", "system.changes.decide")).toBe(false);
  });

  it("sysadmin gets everything; breakglass gets everything EXCEPT emergency.approve", () => {
    for (const p of SYSTEM_PERMISSIONS) {
      expect(roleCan("sysadmin", p)).toBe(true);
    }
    for (const p of SYSTEM_PERMISSIONS) {
      if (p === "system.emergency.approve") {
        expect(roleCan("breakglass", p)).toBe(false);
      } else {
        expect(roleCan("breakglass", p)).toBe(true);
      }
    }
  });

  it("emergency permission matrix", () => {
    const P = (r: SystemRole, p: SystemPermission) => roleCan(r, p);
    // view → every system role
    for (const r of SYSTEM_ROLES) expect(P(r, "system.emergency.view")).toBe(true);
    // request → developer/engineer/hardware/security/sysadmin/breakglass (not viewer)
    expect(P("viewer", "system.emergency.request")).toBe(false);
    for (const r of ["developer", "engineer", "hardware", "security", "sysadmin", "breakglass"] as const) {
      expect(P(r, "system.emergency.request")).toBe(true);
    }
    // execute → security/sysadmin/breakglass only
    for (const r of ["security", "sysadmin", "breakglass"] as const) {
      expect(P(r, "system.emergency.execute")).toBe(true);
    }
    for (const r of ["viewer", "developer", "engineer", "hardware"] as const) {
      expect(P(r, "system.emergency.execute")).toBe(false);
    }
    // approve → sysadmin/security ONLY (breakglass excluded for SoD)
    expect(P("sysadmin", "system.emergency.approve")).toBe(true);
    expect(P("security", "system.emergency.approve")).toBe(true);
    expect(P("breakglass", "system.emergency.approve")).toBe(false);
    for (const r of ["viewer", "developer", "engineer", "hardware"] as const) {
      expect(P(r, "system.emergency.approve")).toBe(false);
    }
  });

  it("developer: app surfaces, no secrets/users/decisions", () => {
    expect(roleCan("developer", "system.flags.manage")).toBe(true);
    expect(roleCan("developer", "system.webhooks.retry")).toBe(true);
    expect(roleCan("developer", "system.deployments.manage")).toBe(true);
    expect(roleCan("developer", "system.secrets.rotate")).toBe(false);
    expect(roleCan("developer", "system.users.manage")).toBe(false);
    expect(roleCan("developer", "system.changes.decide")).toBe(false);
  });

  it("hardware is scoped to the device fleet", () => {
    expect(roleCan("hardware", "system.kiosks.manage")).toBe(true);
    expect(roleCan("hardware", "system.changes.request")).toBe(true);
    expect(roleCan("hardware", "system.flags.manage")).toBe(false);
    expect(roleCan("hardware", "system.security.audit.view")).toBe(false);
    expect(roleCan("hardware", "system.database.schema.view")).toBe(false);
  });

  it("engineer: deploy/db/flags but not secrets or user admin", () => {
    expect(roleCan("engineer", "system.deployments.manage")).toBe(true);
    expect(roleCan("engineer", "system.database.schema.view")).toBe(true);
    expect(roleCan("engineer", "system.flags.manage")).toBe(true);
    expect(roleCan("engineer", "system.secrets.rotate")).toBe(false);
    expect(roleCan("engineer", "system.users.manage")).toBe(false);
    expect(roleCan("engineer", "system.changes.decide")).toBe(false);
  });

  it("security: audit/secrets/users/change decisions, no deployments", () => {
    expect(roleCan("security", "system.security.audit.view")).toBe(true);
    expect(roleCan("security", "system.secrets.rotate")).toBe(true);
    expect(roleCan("security", "system.users.manage")).toBe(true);
    expect(roleCan("security", "system.changes.decide")).toBe(true);
    expect(roleCan("security", "system.deployments.manage")).toBe(false);
    expect(roleCan("security", "system.flags.manage")).toBe(false);
  });

  it("null/unknown roles have no permissions", () => {
    expect(roleCan(null, "system.dashboard.view")).toBe(false);
    expect(roleCan(undefined, "system.dashboard.view")).toBe(false);
    expect(isSystemRole("admin")).toBe(false);
    expect(isSystemRole("sysadmin")).toBe(true);
  });
});

describe("authorize + requireSystem", () => {
  it("401 for unauthenticated, 403 for no role, 403 for missing permission", () => {
    expect(authorize(null, "sysadmin", "system.dashboard.view")).toMatchObject({ ok: false, status: 401 });
    expect(authorize(user(), null, "system.dashboard.view")).toMatchObject({ ok: false, status: 403 });
    expect(authorize(user(), "viewer", "system.flags.manage")).toMatchObject({ ok: false, status: 403 });
    expect(authorize(user(), "viewer", "system.dashboard.view")).toMatchObject({ ok: true });
  });

  it("requireSystem resolves role from profiles.system_role", async () => {
    const ok = await requireSystem("system.dashboard.view", { user: user(), db: dbWithRole("engineer") });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.role).toBe("engineer");

    const denied = await requireSystem("system.secrets.rotate", { user: user(), db: dbWithRole("engineer") });
    expect(denied).toMatchObject({ ok: false, status: 403 });

    const noRole = await requireSystem("system.dashboard.view", { user: user(), db: dbWithRole(null) });
    expect(noRole).toMatchObject({ ok: false, status: 403 });

    const badRole = await requireSystem("system.dashboard.view", { user: user(), db: dbWithRole("admin") });
    expect(badRole).toMatchObject({ ok: false, status: 403 });
  });

  it("requireSystem returns 401 without a session even when db is present", async () => {
    const r = await requireSystem("system.dashboard.view", { user: null, db: dbWithRole("sysadmin") });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("systemRole returns null for missing/erroring profiles", async () => {
    expect(await systemRole(null)).toBeNull();
    const errDb = { from: () => fakeTable({ singles: [{ data: null, error: { message: "boom" } }] }) } as unknown as SupabaseClient;
    expect(await systemRole(user(), errDb)).toBeNull();
    expect(await systemRole(user(), dbWithRole("hardware"))).toBe("hardware");
  });
});

describe("breakglass mutation gating", () => {
  it("only breakglass requires approval for every mutation", () => {
    expect(mutationNeedsApproval("breakglass")).toBe(true);
    for (const r of SYSTEM_ROLES.filter((x) => x !== "breakglass")) expect(mutationNeedsApproval(r)).toBe(false);
    expect(mutationNeedsApproval(null)).toBe(false);
  });
});

describe("system subdomain routing", () => {
  const r = (host: string, path: string, protocol = "https:") => planRoute({ host, path, protocol, base: "zapnivo.com" });

  it("rewrites system.zapnivo.com onto /system with noindex", () => {
    expect(r("system.zapnivo.com", "/")).toEqual({ kind: "rewrite", to: "/system", noindex: true });
    expect(r("system.zapnivo.com", "/changes")).toEqual({ kind: "rewrite", to: "/system/changes", noindex: true });
    expect(r("system.zapnivo.com", "/security/audit")).toEqual({ kind: "rewrite", to: "/system/security/audit", noindex: true });
    expect(r("system.zapnivo.com", "/system").kind).toBe("next");
    expect(r("system.localhost:3000", "/", "http:")).toEqual({ kind: "rewrite", to: "/system", noindex: true });
  });

  it("apex /system paths 308 to the system subdomain", () => {
    expect(r("zapnivo.com", "/system")).toEqual({ kind: "redirect", to: "https://system.zapnivo.com/" });
    expect(r("www.zapnivo.com", "/system/changes")).toEqual({ kind: "redirect", to: "https://system.zapnivo.com/changes" });
  });

  it("cross-portal paths bounce to the right host", () => {
    expect(r("internal.zapnivo.com", "/system")).toEqual({ kind: "redirect", to: "https://system.zapnivo.com/" });
    expect(r("system.zapnivo.com", "/admin")).toEqual({ kind: "redirect", to: "https://internal.zapnivo.com/" });
    expect(r("system.zapnivo.com", "/api/system/overview").kind).toBe("next");
  });
});
