import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { systemSearch, sanitizeSearchQuery, SEARCH_SPECS, PER_ENTITY } from "@/lib/system/search";
import type { SystemRole } from "@/lib/system/rbac";

/* ── Fake Supabase: captures from()/select() and resolves empty pages ── */

type Call = { table: string; select?: string; or?: string; eqs: [string, unknown][] };

function fakeDb(calls: Call[], rows: Record<string, Record<string, unknown>[]> = {}) {
  return {
    from(table: string) {
      const call: Call = { table, eqs: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = (s: string) => { call.select = s; return b; };
      b.or = (f: string) => { call.or = f; return b; };
      b.eq = (k: string, v: unknown) => { call.eqs.push([k, v]); return b; };
      b.order = chain;
      b.limit = chain;
      b.then = (res: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(res);
      return b;
    },
  } as unknown as SupabaseClient;
}

describe("sanitizeSearchQuery", () => {
  it("strips ilike/PostgREST metacharacters and caps length", () => {
    expect(sanitizeSearchQuery("sim-001%")).toBe("sim-001");
    expect(sanitizeSearchQuery("a,b(c)d")).toBe("abcd");
    expect(sanitizeSearchQuery("  heartbeat  ")).toBe("heartbeat");
    expect(sanitizeSearchQuery("x".repeat(200))).toHaveLength(100);
    expect(sanitizeSearchQuery(null)).toBe("");
    expect(sanitizeSearchQuery(42)).toBe("");
  });
});

describe("systemSearch", () => {
  it("returns empty for short queries, null db, or null role", async () => {
    const calls: Call[] = [];
    const db = fakeDb(calls);
    expect((await systemSearch(db, "sysadmin", "a")).groups).toEqual([]);
    expect((await systemSearch(null, "sysadmin", "device")).groups).toEqual([]);
    expect((await systemSearch(db, null, "device")).groups).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("queries only entities the role can view (hardware role)", async () => {
    const calls: Call[] = [];
    const db = fakeDb(calls);
    await systemSearch(db, "hardware" as SystemRole, "sim");
    const tables = calls.map((c) => c.table);
    // hardware has kiosks.view + changes.view but NOT ai/integrations/audit/schema
    expect(tables).toContain("system_devices");
    expect(tables).toContain("device_commands");
    expect(tables).toContain("rental_exceptions");
    expect(tables).toContain("system_change_requests");
    expect(tables).not.toContain("ai_agents");
    expect(tables).not.toContain("error_issues");
    expect(tables).not.toContain("trace_spans");
    expect(tables).not.toContain("incidents");
    expect(tables.filter((t) => t === "system_devices")).toHaveLength(1);
  });

  it("never queries customer/PII tables and never selects *", async () => {
    const calls: Call[] = [];
    const db = fakeDb(calls, {
      system_devices: [{ id: "d1", device_uid: "sim-abc", serial_number: "SIM-ABC", model: "KioskSim-1", status: "active", last_heartbeat_at: "2026-01-01T00:00:00Z" }],
    });
    const res = await systemSearch(db, "sysadmin" as SystemRole, "sim-abc");
    const forbidden = ["profiles", "rentals", "payments", "support_tickets", "support_messages", "contact_messages", "power_banks"];
    for (const c of calls) {
      expect(forbidden).not.toContain(c.table);
      expect(c.select).toBeTruthy();
      expect(c.select).not.toBe("*");
      expect(c.select).not.toContain("email");
    }
    const deviceGroup = res.groups.find((g) => g.type === "device");
    expect(deviceGroup?.items[0]).toMatchObject({ id: "sim-abc", href: "/system/kiosks" });
  });

  it("caps per-entity results and reports truncation", async () => {
    const many = Array.from({ length: PER_ENTITY + 1 }, (_, i) => ({
      id: `sim-${i}`, device_uid: `sim-${i}`, serial_number: null, model: null, status: "active", last_heartbeat_at: null,
    }));
    const calls: Call[] = [];
    const db = fakeDb(calls, { system_devices: many });
    const res = await systemSearch(db, "sysadmin" as SystemRole, "sim");
    const deviceGroup = res.groups.find((g) => g.type === "device");
    expect(deviceGroup?.items).toHaveLength(PER_ENTITY);
    expect(res.truncated).toBe(true);
  });

  it("matches static entities (integrations, migrations) without db rows", async () => {
    const calls: Call[] = [];
    const db = fakeDb(calls);
    const res = await systemSearch(db, "sysadmin" as SystemRole, "stripe");
    const ints = res.groups.find((g) => g.type === "integration");
    expect(ints?.items.some((i) => i.id === "stripe")).toBe(true);
    const mig = await systemSearch(db, "sysadmin" as SystemRole, "0001_init");
    expect(mig.groups.find((g) => g.type === "migration")?.items.length).toBeGreaterThan(0);
  });

  it("every spec declares a real permission", () => {
    for (const s of SEARCH_SPECS) expect(typeof s.perm).toBe("string");
  });
});
