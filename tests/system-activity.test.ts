import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listActivity, encodeCursor, decodeCursor, resourceHref, ACTIVITY_PAGE_SIZE } from "@/lib/system/activity";

type Call = { method: string; args: unknown[] };

function fakeDb(rows: Record<string, unknown>[], calls: Call[] = []) {
  return {
    from(table: string) {
      expect(table).toBe("system_audit_events");
      const b: Record<string, unknown> = {};
      const rec = (m: string) => (...a: unknown[]) => { calls.push({ method: m, args: a }); return b; };
      for (const m of ["select", "eq", "like", "gte", "lte", "or", "order", "limit"]) b[m] = rec(m);
      b.then = (res: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(res);
      return b;
    },
  } as unknown as SupabaseClient;
}

const row = (id: number, created_at: string) => ({
  id, actor_id: "u-1", actor_role: "sysadmin", action: "flag.enabled",
  resource: "feature_flag:x", environment: "production", detail: { flag: "x" },
  correlation_id: null, created_at,
});

describe("activity cursor", () => {
  it("round-trips and rejects malformed cursors", () => {
    const c = encodeCursor({ created_at: "2026-01-01T00:00:00Z", id: "42" });
    expect(decodeCursor(c)).toEqual({ created_at: "2026-01-01T00:00:00Z", id: "42" });
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    // valid b64 but no pipe / bad date
    expect(decodeCursor(Buffer.from("nopipe").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("notadate|1").toString("base64url"))).toBeNull();
  });
});

describe("listActivity", () => {
  it("returns configured:false for null db", async () => {
    const r = await listActivity(null);
    expect(r.configured).toBe(false);
    expect(r.rows).toEqual([]);
  });

  it("applies sanitized filters and keyset cursor", async () => {
    const calls: Call[] = [];
    const db = fakeDb([row(1, "2026-01-02T00:00:00Z")], calls);
    const cur = encodeCursor({ created_at: "2026-01-03T00:00:00Z", id: "9" });
    const r = await listActivity(db, {
      actor: "u-1", actorRole: "sysadmin", actionPrefix: "flag.", resourceType: "feature_flag",
      from: "2026-01-01", to: "2026-01-31", cursor: cur, limit: 10,
    });
    expect(r.rows).toHaveLength(1);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("eq");
    expect(methods).toContain("like");
    expect(methods).toContain("gte");
    expect(methods).toContain("lte");
    expect(methods).toContain("or"); // keyset cursor clause
    const orArg = calls.find((c) => c.method === "or")?.args[0] as string;
    expect(orArg).toContain("created_at.lt.2026-01-03T00:00:00Z");
    expect(orArg).toContain("id.lt.9");
  });

  it("ignores unsafe filter values instead of interpolating them", async () => {
    const calls: Call[] = [];
    const db = fakeDb([], calls);
    await listActivity(db, { actionPrefix: "x'); drop table--", resourceType: "a,b(c)" });
    const likes = calls.filter((c) => c.method === "like").map((c) => c.args[0]);
    expect(likes).toHaveLength(0);
  });

  it("emits nextCursor only when an extra row exists", async () => {
    const rows = Array.from({ length: ACTIVITY_PAGE_SIZE + 1 }, (_, i) => row(i + 1, `2026-01-0${(i % 9) + 1}T00:00:00Z`));
    const r1 = await listActivity(fakeDb(rows), { limit: ACTIVITY_PAGE_SIZE });
    expect(r1.rows).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(r1.nextCursor).toBeTruthy();
    const r2 = await listActivity(fakeDb(rows.slice(0, 3)), { limit: ACTIVITY_PAGE_SIZE });
    expect(r2.nextCursor).toBeNull();
  });
});

describe("resourceHref", () => {
  it("maps known resource types to console pages", () => {
    expect(resourceHref("device_command:abc-123")).toBe("/system/kiosks/commands/abc-123");
    expect(resourceHref("incident:xyz")).toBe("/system/incidents/xyz");
    expect(resourceHref("rental_exception:e1")).toBe("/system/kiosks/exceptions/e1");
    expect(resourceHref("change_request:c1")).toBe("/system/changes");
    expect(resourceHref("feature_flag:beta")).toBe("/system/settings/flags");
    expect(resourceHref("secret:STRIPE_SECRET_KEY")).toBe("/system/secrets");
    expect(resourceHref("system_device:d1")).toBe("/system/kiosks");
    expect(resourceHref("ai_agent:support.assistant")).toBe("/system/ai");
  });

  it("returns null for unknown types and rejects unsafe ids", () => {
    expect(resourceHref("mystery:thing")).toBeNull();
    expect(resourceHref("no-colon")).toBeNull();
    expect(resourceHref("incident:bad id with spaces")).toBe("/system/incidents"); // unsafe id → list fallback
    expect(resourceHref("incident:../../etc")).toBe("/system/incidents"); // traversal rejected
  });
});
