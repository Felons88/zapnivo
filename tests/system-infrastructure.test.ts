import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getDatabaseAdmin,
  getCronJobDetails,
  scanRlsTables,
  scanIndexCount,
  DB_ADMIN_TABLES,
} from "@/lib/system/db-admin";
import {
  getWebhookInspector,
  inspectInfraEvent,
  inboundJobPayloadSummary,
  replayEligibility,
  INFRA_WEBHOOK_SOURCES,
} from "@/lib/system/webhook-inspector";
import { scanApiInventory, classifyRouteSource } from "@/app/system/infrastructure/api/inventory";

/* ── Minimal Supabase stub ─────────────────────────────────────────────── */

type Result = { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null };

/**
 * Chainable stub: every builder method returns itself; awaiting the builder
 * (or .single()/.maybeSingle()) yields the queued result for that table.
 * `results[table]` is consumed in order; when exhausted a default empty
 * success is returned.
 */
function stubDb(tables: Record<string, Result[]> = {}) {
  const queues = new Map(Object.entries(tables).map(([k, v]) => [k, [...v]]));
  const next = (t: string): Result => queues.get(t)?.shift() ?? { data: null, error: null, count: 0 };

  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "ilike", "like", "update", "insert", "delete", "limit"]) {
      b[m] = self;
    }
    b.single = () => Promise.resolve(next(table));
    b.maybeSingle = () => Promise.resolve(next(table));
    // Builders are thenable — awaiting resolves with the next queued result.
    b.then = (resolve: (v: Result) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

/* ── db-admin ──────────────────────────────────────────────────────────── */

describe("db-admin report shape", () => {
  it("unconfigured backend reports honestly", async () => {
    const r = await getDatabaseAdmin(null);
    expect(r.configured).toBe(false);
    expect(r.reachable).toBe(false);
    expect(r.stats).toEqual([]);
    expect(r.backup).toBeNull();
    expect(r.databaseSize.status).toBe("unavailable");
    expect(r.slowQueries.status).toBe("unavailable");
    expect(r.migrations.remoteAppliedState).toBe("untracked");
    expect(r.migrations.repoMigrationCount).toBeGreaterThan(40);
  });

  it("configured backend aggregates counts + backup probe without fabricating", async () => {
    // Generic success for every table; securityReadiness fires many countWhere
    // probes — the stub answers {count:0} for all of them.
    const db = stubDb();
    const r = await getDatabaseAdmin(db);
    expect(r.configured).toBe(true);
    expect(r.reachable).toBe(true);
    expect(r.stats.length).toBe(DB_ADMIN_TABLES.length);
    // Every stat resolved (stub returns count 0) — shape check only.
    for (const s of r.stats) {
      expect(s).toHaveProperty("table");
      expect(s).toHaveProperty("label");
      expect(s.rows).not.toBeNull();
    }
    expect(r.backup).not.toBeNull();
    expect(r.backup!.state).toBeTruthy();
    expect(r.backup!.note).toMatch(/securityReadiness|provider snapshot/i);
  });

  it("per-table query failure reports unavailable, never a fake count", async () => {
    const db = stubDb({
      rentals: [{ count: null, error: { message: "boom", code: "XX000" } }],
    });
    const r = await getDatabaseAdmin(db);
    const rentals = r.stats.find((s) => s.table === "rentals");
    expect(rentals?.rows).toBeNull();
    expect(rentals?.error).toBeTruthy();
  });
});

describe("db-admin repo scans", () => {
  it("RLS scan finds tables with enable row level security", () => {
    const tables = scanRlsTables();
    expect(tables).not.toBeNull();
    expect(tables!.has("rentals")).toBe(true);
    expect(tables!.has("system_devices")).toBe(true);
    expect(tables!.size).toBeGreaterThan(50);
  });

  it("index scan counts CREATE INDEX statements", () => {
    const n = scanIndexCount();
    expect(n).not.toBeNull();
    expect(n!).toBeGreaterThan(50);
  });
});

describe("getCronJobDetails", () => {
  it("returns per-job last run + sanitized detail + span duration", async () => {
    const db = stubDb({
      cron_runs: [
        {
          data: [
            { job: "rentals", ok: true, ran_at: "2026-01-01T12:00:00Z", detail: { swept: 3, api_secret: "sk-live-should-drop", nested: { token: "x", kept: 1 } } },
            { job: "inbound", ok: false, ran_at: "2026-01-01T13:00:00Z", detail: { error: "worker exploded" } },
          ],
          error: null,
        },
      ],
      trace_spans: [
        {
          data: [
            { name: "cron.rentals", duration_ms: 1234, status: "ok", created_at: "2026-01-01T12:00:01Z" },
            { name: "cron.inbound", duration_ms: 87, status: "error", created_at: "2026-01-01T13:00:01Z" },
          ],
          error: null,
        },
      ],
    });
    const m = await getCronJobDetails(db);
    const rentals = m.get("rentals");
    expect(rentals?.lastOk).toBe(true);
    expect(rentals?.lastDurationMs).toBe(1234);
    expect(rentals?.lastSpanStatus).toBe("ok");
    // sanitizeAuditDetail drops secret-ish keys at any depth.
    expect(rentals?.lastDetail).not.toHaveProperty("api_secret");
    expect(JSON.stringify(rentals?.lastDetail)).not.toContain("sk-live");
    expect(rentals?.lastDetail?.nested).toEqual({ kept: 1 });

    const inbound = m.get("inbound");
    expect(inbound?.lastOk).toBe(false);
    expect(inbound?.lastError).toBe("worker exploded");
    expect(inbound?.lastDurationMs).toBe(87);
  });

  it("null db yields empty map", async () => {
    expect((await getCronJobDetails(null)).size).toBe(0);
  });
});

/* ── webhook inspector ─────────────────────────────────────────────────── */

describe("inboundJobPayloadSummary — PII withheld", () => {
  it("shows only allowlisted auth fields; drops email content entirely", () => {
    const summary = inboundJobPayloadSummary({
      from: "customer@example.com",
      subject: "my rental",
      text: "please refund me sk-livefake123",
      recipients: ["support@zapnivo.com"],
      messageId: "<abc@mail>",
      dmarc: "pass",
      spf: "fail",
      dkim: "pass",
      autoSubmitted: false,
    });
    const s = JSON.stringify(summary);
    expect(summary.messageId).toBe("<abc@mail>");
    expect(summary.dmarc).toBe("pass");
    expect(summary).not.toHaveProperty("from");
    expect(summary).not.toHaveProperty("subject");
    expect(summary).not.toHaveProperty("text");
    expect(summary).not.toHaveProperty("recipients");
    expect(s).not.toContain("customer@example.com");
    expect(s).not.toContain("refund me");
    expect(summary.withheld).toContain("from");
    expect(summary.withheld).toContain("text");
  });

  it("non-object payload → honest note", () => {
    expect(inboundJobPayloadSummary(null)).toEqual({ note: "no payload" });
    expect(inboundJobPayloadSummary("x")).toEqual({ note: "no payload" });
  });
});

describe("replayEligibility", () => {
  it("inbound_jobs failed/dead eligible; other statuses not", () => {
    expect(replayEligibility("inbound_jobs", { id: "j1", status: "dead" })).toEqual({ eligible: true, kind: "inbound_job", ref: "inbound_jobs:j1" });
    expect(replayEligibility("inbound_jobs", { id: "j2", status: "done" }).eligible).toBe(false);
  });
  it("email_outbox failed eligible for retry; sent is not", () => {
    expect(replayEligibility("email_outbox", { id: "e1", status: "failed" })).toEqual({ eligible: true, kind: "outbox_email", ref: "email_outbox:e1" });
    expect(replayEligibility("email_outbox", { id: "e2", status: "sent" }).eligible).toBe(false);
  });
  it("payment/other sources never replayable", () => {
    for (const src of ["stripe_events", "inbound_emails", "sms_messages", "system_device_messages"] as const) {
      const r = replayEligibility(src, { id: "x", status: "failed" });
      expect(r.eligible).toBe(false);
    }
  });
});

describe("inspectInfraEvent sanitization", () => {
  it("returns whitelisted fields only — no PII columns", async () => {
    const db = stubDb({
      sms_messages: [{ data: { id: "s1", direction: "inbound", status: "received", provider_sid: "SM123", created_at: "2026-01-01T00:00:00Z" }, error: null }],
    });
    const r = await inspectInfraEvent(db, "sms_messages", "s1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.fields.providerSid).toBe("SM123");
      expect(r.event.fields).not.toHaveProperty("from_number");
      expect(r.event.fields).not.toHaveProperty("to_number");
      expect(r.event.fields).not.toHaveProperty("body");
      expect(r.replay.eligible).toBe(false);
    }
  });

  it("device message detail passes through sanitizeAuditDetail", async () => {
    const db = stubDb({
      system_device_messages: [{
        data: {
          id: "d1", device_id: "dev-1", message_type: "ingest", auth_method: "hmac",
          result: "rejected", received_at: "2026-01-01T00:00:00Z",
          detail: { reason: "bad_signature", device_secret: "supersecret", nested: { api_key: "k", ok: 1 } },
        },
        error: null,
      }],
    });
    const r = await inspectInfraEvent(db, "system_device_messages", "d1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const detail = r.event.fields.detail as Record<string, unknown>;
      expect(detail.reason).toBe("bad_signature");
      expect(detail).not.toHaveProperty("device_secret");
      const s = JSON.stringify(detail);
      expect(s).not.toContain("supersecret");
      expect(s).not.toContain('"api_key"');
    }
  });

  it("404 for missing row; 400 for bad source", async () => {
    const db = stubDb({ stripe_events: [{ data: null, error: null }] });
    const nf = await inspectInfraEvent(db, "stripe_events", "nope");
    expect(nf.ok).toBe(false);
    if (!nf.ok) expect(nf.status).toBe(404);
    const bad = await inspectInfraEvent(db, "not_a_source" as never, "x");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(400);
  });
});

describe("getWebhookInspector", () => {
  it("null db → unconfigured honest empty", async () => {
    const r = await getWebhookInspector(null);
    expect(r.configured).toBe(false);
    expect(r.sources).toEqual([]);
  });

  it("all six sources present with stat fields", async () => {
    const db = stubDb();
    const r = await getWebhookInspector(db);
    expect(r.configured).toBe(true);
    expect(r.sources.map((s) => s.id).sort()).toEqual([...INFRA_WEBHOOK_SOURCES].sort());
    for (const s of r.sources) {
      expect(s).toHaveProperty("events24h");
      expect(s).toHaveProperty("failures24h");
      expect(s).toHaveProperty("lastSuccessAt");
    }
  });
});

/* ── API route inventory ───────────────────────────────────────────────── */

describe("route inventory classification", () => {
  it("detects systemApiGuard permission", () => {
    const c = classifyRouteSource(
      'import { systemApiGuard } from "../_shared";\nexport async function GET(){ const g = await systemApiGuard("system.webhooks.retry"); }',
      "/api/system/webhooks",
    );
    expect(c.auth).toBe("system_rbac");
    expect(c.perm).toBe("system.webhooks.retry");
    expect(c.authSource).toBe("detected");
  });

  it("detects cron secret", () => {
    const c = classifyRouteSource('const secret = process.env.CRON_SECRET; timingSafeEqual(bearer, want);', "/api/cron/uptime");
    expect(c.auth).toBe("cron_secret");
    expect(c.authSource).toBe("detected");
  });

  it("detects device ingest auth", () => {
    const c = classifyRouteSource('import { verifyDeviceAuth } from "@/lib/system/device-auth"; KIOSK_INGEST_SECRET', "/api/devices/events");
    expect(c.auth).toBe("device_ingest");
  });

  it("detects provider webhook signatures", () => {
    expect(classifyRouteSource("stripe.webhooks.constructEvent(body, sig, secret)", "/api/webhooks/stripe").auth).toBe("provider_webhook");
    expect(classifyRouteSource("process.env.EMAIL_INBOUND_SECRET", "/api/webhooks/email/inbound").auth).toBe("provider_webhook");
  });

  it("detects session/staff", () => {
    expect(classifyRouteSource("const u = await getSessionUser();", "/api/rentals").auth).toBe("session");
    expect(classifyRouteSource("const u = await getSessionUser(); if (!isStaff(u)) return 403;", "/api/admin/x").auth).toBe("staff");
  });

  it("unmatched source → honest unclassified", () => {
    const c = classifyRouteSource("export async function GET(){ return Response.json({ok:true}) }", "/api/health");
    expect(c.auth).toBe("public_or_unclassified");
    expect(c.authSource).toBe("heuristic");
  });
});

describe("scanApiInventory (real repo scan)", () => {
  it("finds routes and classifies known endpoints", { timeout: 30_000 }, () => {
    const inv = scanApiInventory();
    expect(inv.routeCount).toBeGreaterThan(150);
    const byPath = new Map(inv.routes.map((r) => [r.path, r]));

    expect(byPath.get("/api/system/jobs")?.auth).toBe("system_rbac");
    expect(byPath.get("/api/system/jobs")?.methods).toContain("GET");
    expect(byPath.get("/api/cron/uptime")?.auth).toBe("cron_secret");
    expect(byPath.get("/api/webhooks/stripe")?.auth).toBe("provider_webhook");
    expect(byPath.get("/api/devices/events")?.auth).toBe("device_ingest");
    expect(byPath.get("/api/system/infrastructure/api-services")?.auth).toBe("system_rbac");

    // Domains cover the real tree.
    const domains = new Set(inv.domains.map((d) => d.domain));
    for (const d of ["system", "cron", "webhooks", "devices", "admin", "partners", "support"]) {
      expect(domains.has(d)).toBe(true);
    }
    // Methods were actually parsed (not all "?").
    expect(inv.routes.filter((r) => r.methods.includes("?")).length).toBeLessThan(inv.routes.length / 2);
  });
});
