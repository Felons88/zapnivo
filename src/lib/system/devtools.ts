import type { SupabaseClient } from "@supabase/supabase-js";
import { scrub } from "@/lib/observability";

/**
 * Developer-tools support for /system/dev/*.
 *
 *  - API_CATALOG: a hand-curated directory of Zapnivo API routes. It is static
 *    on purpose — the filesystem is not reliably available at runtime on
 *    serverless, so routes are listed here and kept honest (auth model noted).
 *  - PING_ALLOWLIST: the ONLY paths POST /api/system/dev/ping will proxy.
 *    GET-only, same-origin, cookie-forwarded so the caller's own session is
 *    used — no arbitrary URLs, no header injection, no POST passthrough.
 *  - listRecentWebhookRows: sanitized recent rows per webhook source for the
 *    webhook tester page (same whitelist discipline as webhooks.ts inspector —
 *    payloads and PII columns are never selected).
 */

export type ApiEndpoint = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  domain: string;
  auth: string;
  description: string;
};

export const API_CATALOG: readonly ApiEndpoint[] = [
  // ── Auth & account ──
  { method: "POST", path: "/api/auth/login", domain: "auth", auth: "public", description: "Email/password sign-in; sets session cookie." },
  { method: "POST", path: "/api/auth/callback", domain: "auth", auth: "public", description: "OAuth/magic-link callback handler." },
  { method: "GET", path: "/api/account/preferences", domain: "auth", auth: "customer session", description: "Read the signed-in customer's preferences." },
  { method: "POST", path: "/api/account/export", domain: "auth", auth: "customer session", description: "Request a GDPR data export." },
  // ── Rentals & payments ──
  { method: "POST", path: "/api/rentals/checkout", domain: "rentals", auth: "customer session", description: "Create a rental checkout session (Stripe)." },
  { method: "GET", path: "/api/rentals/[id]", domain: "rentals", auth: "customer session / receipt", description: "Rental status lookup by id/reference." },
  { method: "GET", path: "/api/receipts/[reference]", domain: "rentals", auth: "public (receipt link)", description: "Public receipt view by reference." },
  { method: "POST", path: "/api/events/passes/[id]/checkout", domain: "rentals", auth: "customer session", description: "Event pass purchase checkout." },
  // ── Payment & comms webhooks ──
  { method: "POST", path: "/api/webhooks/stripe", domain: "webhooks", auth: "Stripe signature", description: "Stripe events: checkout, captures, refunds, disputes. Dedupes via stripe_events." },
  { method: "POST", path: "/api/webhooks/twilio", domain: "webhooks", auth: "Twilio signature", description: "Inbound SMS (STOP/START) + delivery-status callbacks." },
  { method: "POST", path: "/api/webhooks/email/inbound", domain: "webhooks", auth: "EMAIL_INBOUND_SECRET", description: "Brevo inbound mail → inbound_jobs queue." },
  // ── Helpdesk / support ──
  { method: "POST", path: "/api/support/tickets", domain: "helpdesk", auth: "customer session", description: "Create a support ticket." },
  { method: "GET", path: "/api/support/thread/[number]", domain: "helpdesk", auth: "signed thread token", description: "Customer thread read via access token." },
  { method: "POST", path: "/api/support/assistant", domain: "helpdesk", auth: "customer session", description: "AI-drafted support reply (never approves refunds)." },
  { method: "POST", path: "/api/incidents", domain: "helpdesk", auth: "customer session", description: "Customer lost/damaged/stolen charger report → helpdesk ticket + incident_reports row." },
  // ── Kiosk / device ingest ──
  { method: "POST", path: "/api/devices/events", domain: "kiosk", auth: "Bearer KIOSK_INGEST_SECRET", description: "Vendor-agnostic kiosk event ingest (heartbeat, slot_state, power_bank_docked)." },
  { method: "GET", path: "/api/kiosks/manifest", domain: "kiosk", auth: "Bearer KIOSK_INGEST_SECRET", description: "Kiosk playback manifest for a station." },
  { method: "GET", path: "/api/kiosks/playback", domain: "kiosk", auth: "Bearer KIOSK_INGEST_SECRET", description: "Kiosk playback content." },
  { method: "GET", path: "/api/kiosks/creative", domain: "kiosk", auth: "public", description: "Kiosk creative assets." },
  // ── Cron (external scheduler, Bearer CRON_SECRET) ──
  { method: "GET", path: "/api/cron/inbound", domain: "cron", auth: "Bearer CRON_SECRET", description: "Drain inbound_jobs email queue." },
  { method: "GET", path: "/api/cron/rentals", domain: "cron", auth: "Bearer CRON_SECRET", description: "Rental lifecycle sweeps (overdue, auto-return)." },
  { method: "GET", path: "/api/cron/analytics", domain: "cron", auth: "Bearer CRON_SECRET", description: "Roll up analytics_daily aggregates." },
  { method: "GET", path: "/api/cron/uptime", domain: "cron", auth: "Bearer CRON_SECRET", description: "Synthetic uptime probes → uptime_checks/incidents." },
  // ── System control plane (session + system_role perm) ──
  { method: "GET", path: "/api/system/overview", domain: "system", auth: "system.dashboard.view", description: "Command-center KPI overview." },
  { method: "GET", path: "/api/system/status", domain: "system", auth: "system.dashboard.view", description: "Technical status board (this build)." },
  { method: "GET", path: "/api/system/incidents", domain: "system", auth: "system.security.audit.view", description: "Observability incident list." },
  { method: "POST", path: "/api/system/incidents/[id]/acknowledge", domain: "system", auth: "audit.view + changes.request", description: "Stamp acknowledged_at on an open incident." },
  { method: "GET", path: "/api/system/keys", domain: "system", auth: "system.integrations.view", description: "API credential metadata (names/bools only)." },
  { method: "GET", path: "/api/system/dev/endpoints", domain: "system", auth: "system.dashboard.view", description: "This endpoint catalog." },
  { method: "POST", path: "/api/system/dev/ping", domain: "system", auth: "system.dashboard.view", description: "Allowlisted GET proxy for the API explorer try-it panel." },
  { method: "GET", path: "/api/system/integrations", domain: "system", auth: "system.integrations.view", description: "Integration registry + configured booleans." },
  { method: "GET", path: "/api/system/integrations/[id]/health", domain: "system", auth: "system.integrations.view", description: "Bounded live health check for one provider." },
  { method: "GET", path: "/api/system/devices", domain: "system", auth: "system.kiosks.view", description: "Fleet device registry." },
  { method: "GET", path: "/api/system/jobs", domain: "system", auth: "system.dashboard.view", description: "Queue depths + cron run summary." },
  { method: "GET", path: "/api/system/webhooks", domain: "system", auth: "system.integrations.view", description: "Webhook source aggregation." },
  { method: "GET", path: "/api/system/observability", domain: "system", auth: "system.security.audit.view", description: "Errors/logs/traces/cron/uptime overview." },
  { method: "GET", path: "/api/system/flags", domain: "system", auth: "system.flags.view", description: "Feature flag metadata." },
  { method: "POST", path: "/api/system/flags", domain: "system", auth: "system.flags.manage + approval rules", description: "Toggle a feature flag (breakglass needs change request)." },
  { method: "GET", path: "/api/system/secrets", domain: "system", auth: "system.integrations.view", description: "Credential registry metadata." },
  { method: "POST", path: "/api/system/secrets/rotate", domain: "system", auth: "system.secrets.rotate", description: "Request a credential rotation (high risk → change request)." },
  { method: "GET", path: "/api/system/changes", domain: "system", auth: "system.changes.view", description: "Change-request queue." },
  { method: "POST", path: "/api/system/changes/[id]/decision", domain: "system", auth: "system.changes.decide", description: "Approve/reject a change request (not your own)." },
  { method: "GET", path: "/api/system/security/users", domain: "system", auth: "system.users.manage", description: "System-role user listing." },
  { method: "GET", path: "/api/system/ai", domain: "system", auth: "system.ai.view", description: "AI agent registry/status." },
];

export const API_DOMAINS = [...new Set(API_CATALOG.map((e) => e.domain))].sort();

/* ── Ping allowlist (try-it proxy) ──────────────────────────────────────── */

/**
 * Read-only GET endpoints the dev/ping proxy may call. Every entry is a real
 * GET route under /api/system/* that already enforces its own permission —
 * the proxy forwards the caller's cookie so THEIR session/role applies.
 */
export const PING_ALLOWLIST: readonly string[] = [
  "/api/system/overview",
  "/api/system/status",
  "/api/system/incidents",
  "/api/system/keys",
  "/api/system/devices",
  "/api/system/jobs",
  "/api/system/integrations",
  "/api/system/webhooks",
  "/api/system/observability",
  "/api/system/flags",
  "/api/system/ai",
  "/api/system/dev/endpoints",
];

export const isPingAllowed = (path: unknown): path is string =>
  typeof path === "string" && PING_ALLOWLIST.includes(path);

const MAX_BODY = 8 * 1024;
export type PingResult =
  | { ok: true; path: string; status: number; latencyMs: number; contentType: string | null; body: string; truncated: boolean }
  | { ok: false; status: number; error: string };

/**
 * Server-side GET proxy restricted to PING_ALLOWLIST. Forwards ONLY the cookie
 * header (session) and accept — never arbitrary headers, never a body, never a
 * non-allowlisted path. Bounded by a 10s timeout and 8KB response cap.
 */
export async function pingAllowlisted(req: Request, path: string): Promise<PingResult> {
  if (!isPingAllowed(path)) return { ok: false, status: 400, error: "path_not_allowlisted" };
  const origin = new URL(req.url).origin;
  const start = performance.now();
  try {
    const upstream = await fetch(`${origin}${path}`, {
      method: "GET",
      headers: {
        cookie: req.headers.get("cookie") ?? "",
        accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Math.round(performance.now() - start);
    const raw = await upstream.text();
    const truncated = raw.length > MAX_BODY;
    const body = truncated ? raw.slice(0, MAX_BODY) : raw;
    return {
      ok: true, path, status: upstream.status, latencyMs,
      contentType: upstream.headers.get("content-type"),
      body, truncated,
    };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - start);
    const msg = e instanceof Error ? e.message : "fetch failed";
    return { ok: false, status: 502, error: `upstream_error: ${scrub(msg, 160)} (after ${latencyMs}ms)` };
  }
}

/* ── Recent webhook rows (tester page) ──────────────────────────────────── */

export type WebhookTestRow = {
  source: string;
  ref: string | null;
  at: string | null;
  status: string | null;
  detail: string;
};

/**
 * Latest N rows per webhook source with sanitized metadata only — mirrors the
 * column whitelist discipline of webhooks.ts INSPECT_SELECT (payloads/PII are
 * never selected). Best-effort: a source whose table is missing contributes
 * nothing rather than failing the page.
 */
export async function listRecentWebhookRows(db: SupabaseClient | null, perSource = 5): Promise<WebhookTestRow[]> {
  if (!db) return [];
  const limit = Math.min(Math.max(perSource, 1), 20);

  const queries: { source: string; table: string; cols: string; atCol: string; map: (r: Record<string, unknown>) => WebhookTestRow }[] = [
    {
      source: "stripe_events", table: "stripe_events",
      cols: "id,type,received_at", atCol: "received_at",
      map: (r) => ({ source: "stripe_events", ref: `stripe_events:${r.id}`, at: r.received_at as string, status: "recorded", detail: `type=${r.type}` }),
    },
    {
      source: "inbound_jobs", table: "inbound_jobs",
      cols: "id,kind,status,attempts,last_error,created_at", atCol: "created_at",
      map: (r) => ({
        source: "inbound_jobs", ref: `inbound_jobs:${r.id}`, at: r.created_at as string,
        status: r.status as string,
        detail: `kind=${r.kind} attempts=${r.attempts}${r.last_error ? ` err=${scrub(String(r.last_error), 120)}` : ""}`,
      }),
    },
    {
      source: "inbound_emails", table: "inbound_emails",
      cols: "id,status,reason,created_at", atCol: "created_at",
      map: (r) => ({
        source: "inbound_emails", ref: `inbound_emails:${r.id}`, at: r.created_at as string,
        status: r.status as string,
        detail: r.reason ? scrub(String(r.reason), 160) : "accepted/quarantined mail",
      }),
    },
    {
      source: "sms_messages", table: "sms_messages",
      cols: "id,direction,status,created_at", atCol: "created_at",
      map: (r) => ({
        source: "sms_messages", ref: `sms_messages:${r.id}`, at: r.created_at as string,
        status: r.status as string, detail: `direction=${r.direction}`,
      }),
    },
    {
      source: "kiosk_events", table: "kiosk_events",
      cols: "id,event_id,type,result,received_at", atCol: "received_at",
      map: (r) => ({
        source: "kiosk_events", ref: `kiosk_events:${r.id}`, at: r.received_at as string,
        status: (r.result as string) ?? null,
        detail: `event=${r.event_id ?? "?"} type=${r.type}`,
      }),
    },
  ];

  const settled = await Promise.all(
    queries.map(async (q) => {
      try {
        const { data, error } = await db.from(q.table).select(q.cols).order(q.atCol, { ascending: false }).limit(limit);
        if (error || !data) return [] as WebhookTestRow[];
        return ((data ?? []) as unknown as Record<string, unknown>[]).map(q.map);
      } catch {
        return [] as WebhookTestRow[];
      }
    }),
  );
  return settled.flat().sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, limit * queries.length);
}
