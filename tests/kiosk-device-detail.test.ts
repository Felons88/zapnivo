import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSlotInventory, buildVerificationStrip, configStateDiff, deviceIncidentTags,
  findDeviceIncidents, summarizeEventPayload,
  type BankRow, type KioskMeta, type SlotRow,
} from "@/lib/system/kiosk-detail";

/**
 * Phase 4.2 — single-device kiosk detail helpers.
 * Pure-function coverage for the verification strip, slot/bank projection,
 * config diff, payload summarization, and incident tag matching.
 */

const NOW = new Date("2026-03-01T12:00:00Z");
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

/* ── buildVerificationStrip ──────────────────────────────────────────────── */

describe("buildVerificationStrip", () => {
  const base = { adapter: "none", lastHeartbeatAt: null, lastAckAt: null, physicalCert: "none" as const, now: NOW };

  it("always marks api_reachable verified (page rendered server-side)", () => {
    const strip = buildVerificationStrip(base);
    const api = strip.find((b) => b.key === "api_reachable");
    expect(api?.state).toBe("verified");
    expect(strip).toHaveLength(5);
  });

  it("gateway is unverified for none/simulator, unknown for other adapters", () => {
    expect(buildVerificationStrip(base).find((b) => b.key === "gateway_reachable")?.state).toBe("unverified");
    expect(buildVerificationStrip({ ...base, adapter: "simulator" }).find((b) => b.key === "gateway_reachable")?.state).toBe("unverified");
    expect(buildVerificationStrip({ ...base, adapter: "vendor-x" }).find((b) => b.key === "gateway_reachable")?.state).toBe("unknown");
  });

  it("heartbeat: fresh → verified, stale → unverified, missing → unknown", () => {
    const fresh = buildVerificationStrip({ ...base, lastHeartbeatAt: minAgo(5) });
    expect(fresh.find((b) => b.key === "heartbeat_received")?.state).toBe("verified");
    const stale = buildVerificationStrip({ ...base, lastHeartbeatAt: minAgo(120) });
    expect(stale.find((b) => b.key === "heartbeat_received")?.state).toBe("unverified");
    expect(buildVerificationStrip(base).find((b) => b.key === "heartbeat_received")?.state).toBe("unknown");
  });

  it("command ack: present → verified, absent → unknown (never inferred)", () => {
    expect(buildVerificationStrip({ ...base, lastAckAt: minAgo(30) }).find((b) => b.key === "command_acknowledged")?.state).toBe("verified");
    expect(buildVerificationStrip(base).find((b) => b.key === "command_acknowledged")?.state).toBe("unknown");
  });

  it("physical verification only from certification pass/fail/none", () => {
    expect(buildVerificationStrip({ ...base, physicalCert: "pass" }).find((b) => b.key === "physically_verified")?.state).toBe("verified");
    expect(buildVerificationStrip({ ...base, physicalCert: "fail" }).find((b) => b.key === "physically_verified")?.state).toBe("unverified");
    expect(buildVerificationStrip(base).find((b) => b.key === "physically_verified")?.state).toBe("unknown");
  });
});

/* ── buildSlotInventory ──────────────────────────────────────────────────── */

const KIOSKS: KioskMeta[] = [
  { id: "k1", station_id: "st-1", last_seen_at: minAgo(5) },
  { id: "k2", station_id: "st-2", last_seen_at: minAgo(600) }, // stale
  { id: "k3", station_id: "st-3", last_seen_at: null },        // never seen → stale
];
const SLOTS: SlotRow[] = [
  { kiosk_id: "k1", slot_number: 2, state: "occupied", power_bank_id: "b1" },
  { kiosk_id: "k1", slot_number: 1, state: "empty", power_bank_id: null },
  { kiosk_id: "k2", slot_number: 1, state: "occupied", power_bank_id: "b2" },
  { kiosk_id: "k2", slot_number: 2, state: "occupied", power_bank_id: "b3" },
];
const BANKS: BankRow[] = [
  { id: "b1", serial: "SN-001", battery_pct: 87, current_kiosk: "k1", retired: false },
  { id: "b2", serial: "SN-002", battery_pct: null, current_kiosk: "k2", retired: false },   // unknown pct
  { id: "b3", serial: "SN-003", battery_pct: 40, current_kiosk: "k1", retired: true },      // elsewhere + retired
];

describe("buildSlotInventory", () => {
  const inv = buildSlotInventory(SLOTS, BANKS, KIOSKS, NOW);

  it("maps slots sorted by slot_number with bank details", () => {
    const k1 = inv.find((k) => k.kiosk_id === "k1")!;
    expect(k1.slots.map((s) => s.slot_number)).toEqual([1, 2]);
    expect(k1.slots[1].bank).toEqual({ serial: "SN-001", battery_pct: 87, retired: false });
    expect(k1.slots[0].bank).toBeNull();
  });

  it("keeps battery_pct null as null (renders 'unknown', never guessed)", () => {
    const k2 = inv.find((k) => k.kiosk_id === "k2")!;
    const s1 = k2.slots.find((s) => s.slot_number === 1)!;
    expect(s1.bank?.battery_pct).toBeNull();
    expect(s1.bank?.serial).toBe("SN-002");
  });

  it("flags banks whose current_kiosk points at a different kiosk", () => {
    const k2 = inv.find((k) => k.kiosk_id === "k2")!;
    const s2 = k2.slots.find((s) => s.slot_number === 2)!;
    expect(s2.bank_elsewhere).toBe(true);
    expect(s2.bank?.retired).toBe(true);
    const k1s2 = inv.find((k) => k.kiosk_id === "k1")!.slots[1];
    expect(k1s2.bank_elsewhere).toBe(false);
  });

  it("marks stale inventory from kiosk last_seen (heartbeat window)", () => {
    expect(inv.find((k) => k.kiosk_id === "k1")!.stale).toBe(false);
    expect(inv.find((k) => k.kiosk_id === "k2")!.stale).toBe(true);
    expect(inv.find((k) => k.kiosk_id === "k3")!.stale).toBe(true);
  });

  it("returns empty slot list for bound kiosks with no rows", () => {
    expect(inv.find((k) => k.kiosk_id === "k3")!.slots).toEqual([]);
  });
});

/* ── configStateDiff ─────────────────────────────────────────────────────── */

describe("configStateDiff", () => {
  it("no desired → no_desired", () => {
    expect(configStateDiff(null, { a: 1 }).summary).toBe("no_desired");
    expect(configStateDiff({}, null).summary).toBe("no_desired");
  });

  it("null reported → every row no_reported", () => {
    const d = configStateDiff({ brightness: 80, maintenance_mode: false }, null);
    expect(d.summary).toBe("no_reported");
    expect(d.rows.every((r) => r.state === "no_reported")).toBe(true);
  });

  it("matching reported → match; differing → mismatch", () => {
    expect(configStateDiff({ brightness: 80 }, { brightness: 80 }).summary).toBe("match");
    const d = configStateDiff({ brightness: 80 }, { brightness: 50 });
    expect(d.summary).toBe("mismatch");
    expect(d.rows[0]).toMatchObject({ key: "brightness", state: "mismatch", desired: 80, reported: 50 });
  });

  it("missing reported key → mismatch with reported null", () => {
    const d = configStateDiff({ brightness: 80 }, {});
    expect(d.summary).toBe("mismatch");
    expect(d.rows[0].reported).toBeNull();
  });
});

/* ── summarizeEventPayload ───────────────────────────────────────────────── */

describe("summarizeEventPayload", () => {
  it("surfaces well-known telemetry keys", () => {
    expect(summarizeEventPayload({ outcome: "acknowledged", slot_number: 3, command_id: "c1" }))
      .toBe("outcome=acknowledged · slot_number=3 · command_id=c1");
  });

  it("strips secret-shaped keys before summarizing", () => {
    const s = summarizeEventPayload({ outcome: "ok", device_secret: "hunter2", api_key: "x", slot_number: 1 });
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("api_key");
    expect(s).toContain("slot_number=1");
  });

  it("falls back to truncated JSON for unknown shapes; empty → dash", () => {
    expect(summarizeEventPayload(null)).toBe("—");
    expect(summarizeEventPayload({ foo: "bar" })).toBe('{"foo":"bar"}');
    const long = summarizeEventPayload({ blob: "x".repeat(400) });
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith("…")).toBe(true);
  });
});

/* ── deviceIncidentTags + findDeviceIncidents ────────────────────────────── */

describe("deviceIncidentTags", () => {
  it("collects uid, serial, id — deduped, non-empty only", () => {
    expect(deviceIncidentTags({ id: "uuid-1", device_uid: "kiosk-abc", serial_number: "SN-9" }))
      .toEqual(["kiosk-abc", "SN-9", "uuid-1"]);
    expect(deviceIncidentTags({ id: "uuid-1", device_uid: null, serial_number: null })).toEqual(["uuid-1"]);
  });
});

describe("findDeviceIncidents", () => {
  const incidentRows = [
    { id: "i1", number: "INC-1", title: "stale heartbeat", severity: "sev3", status: "detected", source: "cron", services: ["kiosk-abc"], detected_at: "2026-03-01T10:00:00Z", resolved_at: null },
    { id: "i2", number: "INC-2", title: "other", severity: "sev4", status: "resolved", source: "uptime", services: ["web"], detected_at: "2026-03-01T09:00:00Z", resolved_at: "2026-03-01T09:30:00Z" },
    { id: "i3", number: "INC-3", title: "serial match", severity: "sev2", status: "investigating", source: "manual", services: ["SN-9"], detected_at: "2026-03-01T11:00:00Z", resolved_at: null },
  ];

  // Minimal thenable stub: .from(t).select().contains(col,[v]).order().limit(n)
  const stubDb = (rows: Record<string, unknown>[]) => ({
    from: () => ({
      select: () => ({
        contains: (_col: string, vals: string[]) => ({
          order: () => ({
            limit: async (n: number) => ({
              data: rows.filter((r) => (r.services as string[]).some((s) => vals.includes(s))).slice(0, n),
              error: null,
            }),
          }),
        }),
      }),
    }),
  }) as unknown as SupabaseClient;

  it("matches incidents whose services contain any device tag, deduped", async () => {
    const rows = await findDeviceIncidents(stubDb(incidentRows), { id: "uuid-1", device_uid: "kiosk-abc", serial_number: "SN-9" });
    expect(rows.map((r) => r.id).sort()).toEqual(["i1", "i3"]);
    // sorted by detected_at desc
    expect(rows[0].id).toBe("i3");
  });

  it("returns [] when nothing matches or device has no tags", async () => {
    expect(await findDeviceIncidents(stubDb(incidentRows), { id: "x", device_uid: null, serial_number: null })).toEqual([]);
    expect(await findDeviceIncidents(stubDb(incidentRows), { id: "uuid-9", device_uid: "nope", serial_number: null })).toEqual([]);
  });
});
