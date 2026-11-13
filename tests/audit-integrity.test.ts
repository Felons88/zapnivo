import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { auditResource, sanitizeAuditDetail, systemAudit } from "@/lib/system/audit";
import { listDeviceAudit } from "@/lib/system/kiosks";

/**
 * Phase 2.6 audit-integrity tests. Root cause under test: scrub()'s
 * card-number pattern mangled all-digit UUIDs inside `resource`, so
 * eq("resource", deviceAuditResource(id)) never matched. resource is now a
 * typed identifier stored verbatim; detail keeps schema-aware scrubbing.
 */

/* ── In-memory table that actually stores rows and applies filters ──────── */

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

/**
 * In-memory table. `make()` returns a fresh query builder per call (filters
 * never leak across queries); all builders share the same row store.
 * update() is deferred until read so chained .eq() filters apply correctly.
 */
function memTable(seed: Row[] = []) {
  const rows: Row[] = seed.map((r) => ({ ...r }));
  let autoId = 0;
  const inList = (v: unknown): unknown[] =>
    Array.isArray(v) ? v : typeof v === "string" && v.startsWith("(") && v.endsWith(")")
      ? v.slice(1, -1).split(",").map((s) => s.trim())
      : [];
  const make = () => {
    const filters: Filter[] = [];
    let pendingPatch: Row | null = null;
    const match = (r: Row) =>
      filters.every((f) => {
        const cell = r[f.col];
        switch (f.op) {
          case "eq": return cell === f.val;
          case "neq": return cell !== f.val;
          case "in": return inList(f.val).includes(cell);
          case "not-in": return !inList(f.val).includes(cell);
          case "is": return f.val === null ? cell == null : cell === f.val;
          case "lt": return typeof cell === "string" && typeof f.val === "string" ? cell < f.val : false;
          default: return true;
        }
      });
    const materialize = () => {
      if (pendingPatch) {
        for (const r of rows) if (match(r)) Object.assign(r, pendingPatch);
        pendingPatch = null;
      }
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit"]) b[m] = () => b;
    b.eq = (c: string, v: unknown) => { filters.push({ op: "eq", col: c, val: v }); return b; };
    b.neq = (c: string, v: unknown) => { filters.push({ op: "neq", col: c, val: v }); return b; };
    b.in = (c: string, v: unknown) => { filters.push({ op: "in", col: c, val: v }); return b; };
    b.is = (c: string, v: unknown) => { filters.push({ op: "is", col: c, val: v }); return b; };
    b.lt = (c: string, v: unknown) => { filters.push({ op: "lt", col: c, val: v }); return b; };
    b.not = (c: string, op: string, v: unknown) => { if (op === "in") filters.push({ op: "not-in", col: c, val: v }); return b; };
    b.insert = (v: unknown) => {
      for (const r of (Array.isArray(v) ? v : [v]) as Row[]) rows.push({ id: `auto-${++autoId}`, ...r });
      return b;
    };
    b.update = (v: Row) => { pendingPatch = v; return b; };
    b.maybeSingle = async () => { materialize(); return { data: rows.filter(match).at(-1) ?? null, error: null }; };
    b.single = async () => { materialize(); return { data: rows.filter(match).at(-1) ?? null, error: null }; };
    b.then = (res: (v: { data: Row[]; error: null; count: number }) => unknown, rej?: (e: unknown) => unknown) => {
      materialize();
      const out = rows.filter(match);
      return Promise.resolve({ data: out, error: null, count: out.length }).then(res, rej);
    };
    return b;
  };
  return { make, rows };
}
function memDb(tables: Record<string, ReturnType<typeof memTable>>) {
  return { from: (t: string) => (tables[t] ?? memTable()).make() } as unknown as SupabaseClient;
}
/** All rows in a table (test helper). */
const all = async (t: ReturnType<typeof memTable>) =>
  (await memDb({ t }).from("t").select("*")) as unknown as { data: Row[] };

/* ── auditResource ──────────────────────────────────────────────────────── */

describe("auditResource", () => {
  it("preserves typed identifiers verbatim — including all-digit UUIDs", () => {
    // This UUID is exactly what the card-number pattern used to mangle.
    const uuid = "12345678-1234-1234-1234-123456789012";
    expect(auditResource(`system_device:${uuid}`)).toBe(`system_device:${uuid}`);
    expect(auditResource("incidents:list")).toBe("incidents:list");
    expect(auditResource("kiosk_certification:fleet")).toBe("kiosk_certification:fleet");
    expect(auditResource("webhook:stripe_events:12345678-1234-1234-1234-123456789012")).toBe(
      "webhook:stripe_events:12345678-1234-1234-1234-123456789012",
    );
  });

  it("falls back to scrub() for non-identifier content", () => {
    // '?' is outside the safe charset → free-text path → secrets redacted.
    const out = auditResource("dev:ping:/api/x?api_key=abcdef123456");
    expect(out).not.toContain("abcdef123456");
    expect(out).toContain("[redacted]");
    expect(auditResource("")).toBe("");
    // Non-identifier free text falls back to scrub() — secrets still redacted.
    expect(auditResource("x:token=abcdef123456")).not.toContain("abcdef123456");
    expect(auditResource("plain text, no colon")).toBe("plain text, no colon");
  });
});

/* ── systemAudit resource + detail ──────────────────────────────────────── */

describe("systemAudit identifier integrity", () => {
  it("stores an all-digit-UUID resource verbatim (the Phase 2.5 corruption)", async () => {
    const uuid = "12345678-1234-1234-1234-123456789012";
    const t = memTable();
    const db = memDb({ system_audit_events: t });
    await systemAudit(db, { actor: { id: "u1", role: "sysadmin" }, action: "kiosk.status_changed", resource: `system_device:${uuid}` });
    const { data: rows } = await all(t);
    const row = rows[0];
    expect(row.resource).toBe(`system_device:${uuid}`);
    expect(String(row.resource)).not.toContain("[redacted]");
  });

  it("preserves UUIDs in detail identifier fields while scrubbing free text", async () => {
    const rentalId = "22345678-1234-4234-8234-123456789012";
    const t = memTable();
    const db = memDb({ system_audit_events: t });
    await systemAudit(db, {
      actor: null, action: "exception.transitioned", resource: "rental_exception:32345678-1234-4234-8234-123456789012",
      detail: {
        rental_id: rentalId,
        command_id: "42345678-1234-4234-8234-123456789012",
        note: "customer called 555-123-4567 about the kiosk",
        amount_cents: 1299,
      },
    });
    const { data: res } = await all(t);
    const detail = res[0].detail as Record<string, unknown>;
    expect(detail.rental_id).toBe(rentalId);
    expect(detail.command_id).toBe("42345678-1234-4234-8234-123456789012");
    expect(detail.amount_cents).toBe(1299);
    expect(String(detail.note)).toContain("[phone]");
    expect(String(detail.note)).not.toContain("555-123-4567");
  });

  it("always drops secret-ish keys and redacts secret-looking values", async () => {
    const t = memTable();
    const db = memDb({ system_audit_events: t });
    await systemAudit(db, {
      actor: null, action: "x.y", resource: "test:1",
      detail: {
        api_key: "sk-abcdef1234567890",
        token: "tok_abcdef123456",
        password: "hunter2hunter2",
        signature: "sig_abcdef123456",
        authorization: "Bearer abcdef123456",
        nested: { secret: "shh", ok: "fine" },
        note: "used Bearer abcdef123456 to call upstream",
      },
    });
    const { data: res } = await all(t);
    const detail = JSON.stringify(res[0].detail);
    for (const leaked of ["sk-abcdef", "tok_abcdef", "hunter2", "sig_abcdef", "abcdef123456", "shh"]) {
      expect(detail).not.toContain(leaked);
    }
    const d = res[0].detail as Record<string, unknown>;
    expect((d.nested as Record<string, unknown>).ok).toBe("fine");
    expect(String(d.note)).toContain("[redacted]");
  });
});

/* ── Correlation roundtrip: insert → eq("resource") query ────────────────── */

describe("resource correlation roundtrip", () => {
  it("listDeviceAudit finds rows written by systemAudit (eq resource works)", async () => {
    const deviceId = "12345678-1234-4234-8234-123456789012";
    const auditTable = memTable();
    const db = memDb({ system_audit_events: auditTable });
    await systemAudit(db, { actor: { id: "u1", role: "hardware" }, action: "kiosk.registered", resource: `system_device:${deviceId}` });
    await systemAudit(db, { actor: { id: "u1", role: "hardware" }, action: "kiosk.status_changed", resource: `system_device:${deviceId}` });
    await systemAudit(db, { actor: { id: "u1", role: "hardware" }, action: "kiosk.registered", resource: "system_device:99999999-9999-4999-8999-999999999999" });

    const events = await listDeviceAudit(db, deviceId, 50);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.action).sort()).toEqual(["kiosk.registered", "kiosk.status_changed"]);
    expect(events.every((e) => e.resource === `system_device:${deviceId}`)).toBe(true);
  });

  it("legacy mangled rows remain readable by their stored value", async () => {
    // Rows written before the fix have the corrupted resource verbatim in the DB.
    const legacy = "system_device:[redacted]-[redacted]";
    const auditTable = memTable([{
      id: "old-1", actor_id: null, actor_role: "system", action: "kiosk.status_changed",
      resource: legacy, environment: "production", detail: {}, correlation_id: "c1",
      created_at: "2026-01-01T00:00:00Z",
    }]);
    const db = memDb({ system_audit_events: auditTable });
    const { data } = await db.from("system_audit_events").select("id,resource").eq("resource", legacy);
    expect((data as Row[])).toHaveLength(1);
    expect((data as Row[])[0].resource).toBe(legacy);
  });
});

/* ── sanitizeAuditDetail ────────────────────────────────────────────────── */

describe("sanitizeAuditDetail", () => {
  it("handles nested objects/arrays with depth + breadth caps", () => {
    const deep = { a: { b: { c: { d: { e: "too deep" } } } } };
    const out = sanitizeAuditDetail({ deep, list: ["x", 1, true, null], keep: "ok" });
    expect(out.keep).toBe("ok");
    expect(Array.isArray(out.list)).toBe(true);
    const d = out.deep as Record<string, unknown>;
    // depth 3 cap → innermost level collapses to "[truncated]"
    expect(JSON.stringify(d)).toContain("[truncated]");
  });

  it("preserves non-UUID identifier values under identifier keys only", () => {
    const out = sanitizeAuditDetail({
      device_uid: "kiosk-a1b2c3d4e5f6",
      serial_number: "SN-0042",
      free_text: "kiosk-a1b2c3d4e5f6", // same value, non-identifier key → scrubbed? (no patterns → unchanged anyway)
    });
    expect(out.device_uid).toBe("kiosk-a1b2c3d4e5f6");
    expect(out.serial_number).toBe("SN-0042");
  });
});
