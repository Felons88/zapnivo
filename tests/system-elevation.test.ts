import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  grantElevation, hasElevation, activeElevation, requireElevation, ELEVATION_TTL_MS,
} from "@/lib/system/elevation";
import { systemRole } from "@/lib/system/rbac";
import type { SessionUser } from "@/lib/auth";

const user = (id = "u1"): SessionUser => ({ id, email: "op@zapnivo.com", role: "staff", organizationId: null });

/* ── Minimal Supabase stub (same shape as tests/system-rbac.test.ts) ── */
type Result = { data?: unknown; error?: { message: string } | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown } = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "insert", "update", "upsert", "delete", "filter"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "insert") b._insert = a[0];
      if (m === "update") b._update = a[0];
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
  const db = {
    from: (t: string) => { calls.push(t); return tables[t] ?? fakeTable(); },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const elevRow = (over: Record<string, unknown> = {}) => ({
  id: "e1", profile_id: "u1", method: "totp",
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  consumed_action: null, created_ip: null, ...over,
});

describe("grantElevation", () => {
  it("inserts a ~15-minute elevation and audits it — never touches auth_sessions", async () => {
    const now = Date.now();
    const elevTable = fakeTable({ singles: [{ data: { id: "e1", expires_at: new Date(now + ELEVATION_TTL_MS).toISOString() }, error: null }] });
    const auditTable = fakeTable();
    const { db, calls } = fakeDb({ system_elevations: elevTable, system_audit_events: auditTable });

    const res = await grantElevation(db, "u1", "totp", { nowMs: now });
    expect(res.ok).toBe(true);
    const inserted = elevTable._insert as Record<string, unknown>;
    expect(inserted.profile_id).toBe("u1");
    expect(inserted.method).toBe("totp");
    const ttl = Date.parse(String(inserted.expires_at)) - Date.parse(String(inserted.created_at));
    expect(ttl).toBe(ELEVATION_TTL_MS);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    // Elevation does NOT extend the session — auth_sessions is never written.
    expect(calls).not.toContain("auth_sessions");
    expect(calls).toContain("system_audit_events");
  });

  it("fails honestly without a db", async () => {
    expect(await grantElevation(null, "u1", "totp")).toMatchObject({ ok: false });
  });
});

describe("hasElevation / activeElevation", () => {
  it("returns the live elevation row", async () => {
    const { db } = fakeDb({ system_elevations: fakeTable({ list: { data: [elevRow()] } }) });
    expect(await hasElevation(db, "u1")).toBe(true);
    const row = await activeElevation(db, "u1");
    expect(row?.method).toBe("totp");
  });

  it("rejects expired and too-old elevations", async () => {
    const expired = elevRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const { db: d1 } = fakeDb({ system_elevations: fakeTable({ list: { data: [expired] } }) });
    expect(await hasElevation(d1, "u1")).toBe(false);

    const old = elevRow({
      created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const { db: d2 } = fakeDb({ system_elevations: fakeTable({ list: { data: [old] } }) });
    expect(await hasElevation(d2, "u1")).toBe(false);
    expect(await hasElevation(d2, "u1", 120)).toBe(true); // wider window accepts it
  });

  it("returns null for missing db/user", async () => {
    expect(await hasElevation(null, "u1")).toBe(false);
    expect(await hasElevation(fakeDb({}).db, "")).toBe(false);
  });
});

describe("requireElevation", () => {
  it("401 without user, 403 step_up_required without elevation, ok with one", async () => {
    const { db } = fakeDb({ system_elevations: fakeTable({ list: { data: [elevRow()] } }) });
    expect(await requireElevation(db, null)).toMatchObject({ ok: false, status: 401 });

    const { db: empty } = fakeDb({ system_elevations: fakeTable({ list: { data: [] } }) });
    const denied = await requireElevation(empty, user());
    expect(denied).toMatchObject({ ok: false, status: 403, code: "step_up_required" });

    const ok = await requireElevation(db, user());
    expect(ok).toMatchObject({ ok: true, method: "totp" });
  });
});

describe("suspended system users", () => {
  it("systemRole returns null when profiles.system_suspended is true", async () => {
    const suspendedDb = {
      from: () => fakeTable({ singles: [{ data: { system_role: "sysadmin", system_suspended: true }, error: null }] }),
    } as unknown as SupabaseClient;
    expect(await systemRole(user(), suspendedDb)).toBeNull();

    const activeDb = {
      from: () => fakeTable({ singles: [{ data: { system_role: "sysadmin", system_suspended: false }, error: null }] }),
    } as unknown as SupabaseClient;
    expect(await systemRole(user(), activeDb)).toBe("sysadmin");

    // Rows without the column (pre-0043 shape) are treated as not suspended.
    const legacyDb = {
      from: () => fakeTable({ singles: [{ data: { system_role: "viewer" }, error: null }] }),
    } as unknown as SupabaseClient;
    expect(await systemRole(user(), legacyDb)).toBe("viewer");
  });
});
