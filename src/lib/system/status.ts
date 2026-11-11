import type { SupabaseClient } from "@supabase/supabase-js";
import { backendConfigured } from "@/lib/supabase";
import { INTEGRATION_PROVIDERS } from "./integrations";
import { kioskAdapterName } from "./kiosks";

/**
 * Technical status board for /system/status — "is Zapnivo technically healthy".
 *
 * Every row is derived from a REAL signal:
 *  - supabase        — bounded `select … head` probe against the service client
 *  - stripe/brevo/twilio/openrouter — configured booleans from the integration
 *    registry (live health checks stay on /system/integrations/[id]/health)
 *  - kiosk adapter   — KIOSK_ADAPTER env / getKioskAdapter().name
 *  - cron jobs       — latest cron_runs row per job (age + ok flag)
 *  - error_events    — count in the last 24h
 *  - uptime_checks   — latest probe result per URL
 *
 * Status vocabulary is deliberately coarse: `operational` (verified ok),
 * `degraded` (verified problem), `unconfigured` (missing env/config — not an
 * outage), `unknown` (cannot determine — no data or not verified). Nothing here
 * claims health that wasn't actually checked.
 */

export type StatusLevel = "operational" | "degraded" | "unconfigured" | "unknown";
export type StatusRow = {
  component: string;
  status: StatusLevel;
  detail: string;
  /** ISO timestamp of the underlying check/data point, or null if none exists. */
  checkedAt: string | null;
};
export type SystemStatus = {
  configured: boolean;
  checkedAt: string;
  rows: StatusRow[];
  summary: Record<StatusLevel, number>;
};

const NOW = () => new Date().toISOString();
const age = (iso: string | null) => {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m ago";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/** Bounded probes only — every DB read is head-count or a small latest-row select. */
export async function getSystemStatus(db: SupabaseClient | null): Promise<SystemStatus> {
  const checkedAt = NOW();
  const rows: StatusRow[] = [];
  const since24 = new Date(Date.now() - 86_400_000).toISOString();

  // ── Supabase connectivity ──
  if (!backendConfigured() || !db) {
    rows.push({ component: "supabase", status: "unconfigured", detail: "Supabase env vars missing or service client unavailable", checkedAt });
  } else {
    try {
      const { error } = await db.from("system_feature_flags").select("key", { count: "exact", head: true }).limit(1);
      rows.push(error
        ? { component: "supabase", status: "degraded", detail: `probe failed: ${error.code ?? error.message}`, checkedAt }
        : { component: "supabase", status: "operational", detail: "bounded select succeeded", checkedAt });
    } catch (e) {
      rows.push({ component: "supabase", status: "degraded", detail: `probe threw: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`, checkedAt });
    }
  }

  // ── Third-party providers: configured booleans only (no live calls here) ──
  const PROVIDER_IDS = ["stripe", "brevo", "twilio", "openrouter"] as const;
  for (const id of PROVIDER_IDS) {
    const p = INTEGRATION_PROVIDERS.find((x) => x.id === id);
    if (!p) continue;
    let configured = false;
    try { configured = p.configured(); } catch { configured = false; }
    rows.push({
      component: id,
      status: configured ? "unknown" : "unconfigured",
      detail: configured
        ? `configured (${p.mode()}) — live check via /system/integrations`
        : `not configured — missing env: ${p.envVars.join(", ") || "(none)"}`,
      checkedAt,
    });
  }

  // ── Kiosk adapter ──
  const adapter = kioskAdapterName();
  rows.push({
    component: "kiosk_adapter",
    status: adapter === "none" ? "unconfigured" : adapter === "simulator" ? "unknown" : "unknown",
    detail: adapter === "none"
      ? "KIOSK_ADAPTER=none — NullKioskAdapter; no hardware path"
      : adapter === "simulator"
        ? "KIOSK_ADAPTER=simulator — synthetic events only, no real settlement"
        : `KIOSK_ADAPTER=${adapter} — selection recorded; no verified hardware adapter`,
    checkedAt,
  });

  if (db) {
    const [cronRes, errRes, upRes] = await Promise.all([
      db.from("cron_runs").select("job,ok,ran_at").order("ran_at", { ascending: false }).limit(500),
      db.from("error_events").select("id", { count: "exact", head: true }).gte("occurred_at", since24),
      db.from("uptime_checks").select("url,ok,status_code,latency_ms,checked_at").order("checked_at", { ascending: false }).limit(2000),
    ]);

    // ── Cron jobs: latest run per job ──
    const crons = (cronRes.data ?? []) as { job: string; ok: boolean; ran_at: string }[];
    const byJob = new Map<string, { ok: boolean; ran_at: string }>();
    for (const c of crons) if (!byJob.has(c.job)) byJob.set(c.job, { ok: c.ok, ran_at: c.ran_at });
    if (byJob.size === 0) {
      rows.push({ component: "cron", status: "unknown", detail: "no cron_runs recorded", checkedAt: null });
    } else {
      for (const [job, last] of [...byJob.entries()].sort()) {
        rows.push({
          component: `cron:${job}`,
          status: last.ok ? "operational" : "degraded",
          detail: `last run ${age(last.ran_at)} — ${last.ok ? "ok" : "FAILED"}`,
          checkedAt: last.ran_at,
        });
      }
    }

    // ── Error events 24h ──
    const errCount = errRes.error ? null : (errRes.count ?? 0);
    rows.push({
      component: "error_events",
      status: errRes.error ? "unknown" : errCount === 0 ? "operational" : "degraded",
      detail: errRes.error ? `not queryable: ${errRes.error.code ?? errRes.error.message}` : `${errCount} error event(s) in last 24h`,
      checkedAt,
    });

    // ── Uptime checks: latest per URL ──
    const ups = (upRes.data ?? []) as { url: string; ok: boolean; status_code: number | null; latency_ms: number | null; checked_at: string }[];
    const byUrl = new Map<string, { ok: boolean; status_code: number | null; latency_ms: number | null; checked_at: string }>();
    for (const u of ups) if (!byUrl.has(u.url)) byUrl.set(u.url, u);
    if (byUrl.size === 0) {
      rows.push({ component: "uptime", status: "unknown", detail: "no uptime_checks recorded — probe cron may not have run", checkedAt: null });
    } else {
      for (const [url, last] of [...byUrl.entries()].sort()) {
        rows.push({
          component: `uptime:${url}`,
          status: last.ok ? "operational" : "degraded",
          detail: `HTTP ${last.status_code ?? "?"} · ${last.latency_ms ?? "?"}ms · ${age(last.checked_at)}`,
          checkedAt: last.checked_at,
        });
      }
    }
  } else {
    rows.push({ component: "cron", status: "unknown", detail: "backend not configured", checkedAt: null });
    rows.push({ component: "error_events", status: "unknown", detail: "backend not configured", checkedAt: null });
    rows.push({ component: "uptime", status: "unknown", detail: "backend not configured", checkedAt: null });
  }

  const summary: Record<StatusLevel, number> = { operational: 0, degraded: 0, unconfigured: 0, unknown: 0 };
  for (const r of rows) summary[r.status] += 1;
  return { configured: Boolean(db), checkedAt, rows, summary };
}
