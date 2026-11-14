import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSystemHealth, worstState, type HealthState } from "@/lib/system/health-dashboard";

/**
 * Health-dashboard aggregation tests:
 *  - section set is complete and stable; db=null yields honest
 *    unconfigured/unverified states (never fabricated health).
 *  - failing sub-systems degrade ONLY their own section.
 *  - awaiting_hardware surfaces when the kiosk fleet has devices but
 *    KIOSK_ADAPTER=none; alert delivery reflects app_logs evidence.
 */

type Result = { data?: unknown; error?: { code?: string; message: string } | null; count?: number | null };
type Query = { table: string; cols: unknown; filters: unknown[][] };
type Handler = (q: Query) => Result;

function fakeDb(handlers: Record<string, Handler>): SupabaseClient {
  const from = (table: string) => {
    const q: Query = { table, cols: null, filters: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    b.select = (cols?: unknown) => { q.cols = cols; return b; };
    for (const m of ["order", "limit", "neq", "not", "is", "lt", "lte", "gt", "filter"]) {
      b[m] = () => b;
    }
    for (const m of ["eq", "in", "gte"]) {
      b[m] = (...a: unknown[]) => { q.filters.push([m, ...a]); return b; };
    }
    const resolve = (): Result => {
      const h = handlers[table];
      return h ? h(q) : { data: [], error: null, count: 0 };
    };
    b.maybeSingle = async () => {
      const r = resolve();
      const d = Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? null);
      return { data: d, error: r.error ?? null };
    };
    b.single = b.maybeSingle;
    b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(res, rej);
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const ENV_KEYS = [
  "ALERT_WEBHOOK_URL", "OPENROUTER_API_KEY", "KIOSK_ADAPTER",
  "STRIPE_SECRET_KEY", "NEXT_PUBLIC_GTM_ID", "NEXT_PUBLIC_GA_MEASUREMENT_ID",
  "NEXT_PUBLIC_MAPBOX_TOKEN", "CRON_SECRET",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const section = (h: Awaited<ReturnType<typeof getSystemHealth>>, id: string) =>
  h.sections.find((s) => s.id === id)!;

describe("worstState", () => {
  it("ranks unreachable > degraded > awaiting_hardware > unconfigured > unverified > healthy", () => {
    const order: HealthState[] = ["healthy", "unverified", "unconfigured", "awaiting_hardware", "degraded", "unreachable"];
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        expect(worstState([order[i], order[j]])).toBe(order[j]);
      }
    }
    expect(worstState([])).toBe("healthy");
  });
});

describe("getSystemHealth — shape & honesty", () => {
  it("returns all 8 sections with stable ids and links", async () => {
    const h = await getSystemHealth(null);
    expect(h.sections.map((s) => s.id)).toEqual([
      "app_hosts", "integrations", "jobs", "webhooks",
      "kiosk_fleet", "update_campaigns", "ai_services", "alert_delivery",
    ]);
    for (const s of h.sections) {
      expect(s.href.startsWith("/system/")).toBe(true);
      expect(s.summary.length).toBeGreaterThan(0);
    }
  });

  it("db=null: data-backed sections are unconfigured, evidence sections unverified — never healthy", async () => {
    const h = await getSystemHealth(null);
    expect(section(h, "app_hosts").state).toBe("unverified");
    expect(section(h, "jobs").state).toBe("unconfigured");
    expect(section(h, "webhooks").state).toBe("unconfigured");
    expect(section(h, "kiosk_fleet").state).toBe("unconfigured");
    expect(section(h, "update_campaigns").state).toBe("unconfigured");
    expect(section(h, "ai_services").state).toBe("unconfigured");
    expect(section(h, "alert_delivery").state).toBe("unconfigured");
    expect(h.overall).not.toBe("healthy");
  });

  it("empty DB: sections report honest empty states, not fabricated health", async () => {
    const h = await getSystemHealth(fakeDb({}));
    // No health-profile audits or uptime rows → every app unverified.
    expect(section(h, "app_hosts").state).toBe("unverified");
    // No cron_runs → jobs unverified; webhook sources exist but saw nothing.
    expect(section(h, "jobs").state).toBe("unverified");
    expect(section(h, "webhooks").state).toBe("unverified");
    // Fleet scan succeeds with zero devices → unverified, not healthy.
    expect(section(h, "kiosk_fleet").state).toBe("unverified");
    // Zero campaigns / zero agents are real counts → healthy / unverified.
    expect(section(h, "update_campaigns").state).toBe("healthy");
    expect(section(h, "ai_services").state).toBe("unverified");
    expect(h.overall).not.toBe("healthy");
  });
});

describe("getSystemHealth — section degradation", () => {
  it("failing cron marks ONLY the jobs section degraded", async () => {
    const recent = new Date().toISOString();
    const db = fakeDb({
      cron_runs: () => ({ data: [{ job: "uptime", ok: false, ran_at: recent }], error: null }),
    });
    const h = await getSystemHealth(db);
    const jobs = section(h, "jobs");
    expect(jobs.state).toBe("degraded");
    expect(jobs.issue).toContain("uptime");
    // Other sections unaffected.
    expect(section(h, "update_campaigns").state).toBe("healthy");
    expect(h.overall).toBe("degraded");
  });

  it("blocked/failed campaigns degrade the campaigns section", async () => {
    const db = fakeDb({
      kiosk_update_campaigns: () => ({
        data: [{ status: "blocked" }, { status: "active" }, { status: "failed" }],
        error: null,
      }),
    });
    const h = await getSystemHealth(db);
    const c = section(h, "update_campaigns");
    expect(c.state).toBe("degraded");
    expect(c.summary).toContain("blocked");
    expect(c.issue).toContain("blocked");
  });

  it("enabled agents without OPENROUTER_API_KEY degrade ai_services honestly", async () => {
    const db = fakeDb({
      ai_agents: (q) => {
        const enabled = q.filters.some((f) => f[0] === "eq" && f[1] === "enabled" && f[2] === true);
        return { data: null, error: null, count: enabled ? 2 : 1 };
      },
    });
    const h = await getSystemHealth(db);
    const ai = section(h, "ai_services");
    expect(ai.state).toBe("degraded");
    expect(ai.issue).toContain("OPENROUTER_API_KEY");
    expect(ai.summary).toContain("2 enabled");
  });

  it("kiosk fleet with devices + KIOSK_ADAPTER=none reports awaiting_hardware", async () => {
    const now = new Date().toISOString();
    const device = {
      id: "dev-1", status: "active", last_heartbeat_at: now, firmware_version: "1.0.0",
      venue_id: null, region: null, auth_method: "device_key", device_secret_hash: "x",
      credential_issued_at: now, credential_expires_at: null, credential_revoked_at: null,
      last_authed_at: now, last_message_ts: null,
    };
    const db = fakeDb({
      system_devices: () => ({ data: [device], error: null, count: 1 }),
    });
    const h = await getSystemHealth(db);
    const f = section(h, "kiosk_fleet");
    expect(f.state).toBe("awaiting_hardware");
    expect(f.summary).toContain("1 devices");
    expect(f.summary).toContain("adapter=none");
    expect(f.issue).toContain("GATEWAY-ADAPTER");
  });

  it("fleet stats failure degrades only kiosk_fleet to unreachable", async () => {
    const db = fakeDb({
      system_devices: () => ({ data: null, error: { message: "connection reset" } }),
    });
    const h = await getSystemHealth(db);
    expect(section(h, "kiosk_fleet").state).toBe("unreachable");
    expect(section(h, "update_campaigns").state).toBe("healthy");
  });
});

describe("getSystemHealth — alert delivery", () => {
  it("ALERT_WEBHOOK_URL unset → unconfigured regardless of DB", async () => {
    const h = await getSystemHealth(fakeDb({}));
    const a = section(h, "alert_delivery");
    expect(a.state).toBe("unconfigured");
    expect(a.summary).toContain("not set");
  });

  it("set + latest app_logs row delivered → healthy with timestamp", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/secret-path";
    const ts = new Date().toISOString();
    const db = fakeDb({
      app_logs: () => ({ data: { ts, message: "external_alert_delivered" }, error: null }),
    });
    const h = await getSystemHealth(db);
    const a = section(h, "alert_delivery");
    expect(a.state).toBe("healthy");
    expect(a.checkedAt).toBe(ts);
    // The webhook URL (which can embed provider tokens) must never leak.
    expect(JSON.stringify(h)).not.toContain("hooks.example.com");
  });

  it("set + latest row failed → degraded; set + no rows → unverified", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/x";
    const failed = await getSystemHealth(fakeDb({
      app_logs: () => ({ data: { ts: new Date().toISOString(), message: "external_alert_failed" }, error: null }),
    }));
    expect(section(failed, "alert_delivery").state).toBe("degraded");
    const silent = await getSystemHealth(fakeDb({}));
    expect(section(silent, "alert_delivery").state).toBe("unverified");
    expect(section(silent, "alert_delivery").issue).toContain("no alert has ever been emitted");
  });
});
