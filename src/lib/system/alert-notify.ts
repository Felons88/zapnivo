import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog, scrub } from "@/lib/observability";
import { systemAudit, type SystemActor } from "./audit";

/**
 * Alert delivery ledger + webhook sender (Phase 4.4).
 *
 * DELIVERY TOPOLOGY (verified, not assumed):
 *  - reportError → alertNewIssue (src/lib/observability.ts) is the single
 *    emit seam for error-issue alerts. It already calls alertStaff (staff
 *    email outbox) and externalAlert (src/lib/alerts.ts → ALERT_WEBHOOK_URL,
 *    in-process cooldown). Those remain the actual POST paths — this module
 *    does NOT double-post for that seam; `notifyIssueAlert` records the
 *    delivery decision into alert_notifications so the console can show
 *    configured?/last-sent/failures honestly.
 *  - `sendTestAlert` DOES perform a real POST — it is the authorized
 *    end-to-end verification of the configured webhook destination.
 *  - `notifyAlert(post: true)` is available for future emitters that want a
 *    recorded + posted alert without going through reportError.
 *
 * Payload contract matches src/lib/alerts.ts externalAlert (Slack-compatible
 * { text, zapnivo } shape) so the same webhook endpoint works for both.
 * Everything is PII/secret-free: title/body/link are scrubbed, the link is
 * restricted to internal /system/ paths, and the fingerprint must match a
 * safe charset.
 */

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertNotificationRow = {
  id: string;
  fingerprint: string;
  kind: "alert" | "test";
  severity: AlertSeverity;
  status: "sent" | "failed" | "skipped";
  detail: string | null;
  sent_at: string | null;
  created_at: string;
};

/** Webhook destinations the APP posts to. UPTIME_ALERT_WEBHOOK_URL is a
 *  GitHub-Actions repo secret for .github/workflows/uptime.yml — it is NOT an
 *  app destination and is intentionally not posted to from here. */
export function alertWebhookUrls(): string[] {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  return url ? [url] : [];
}

const FINGERPRINT_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const safeFingerprint = (fp: string) => (FINGERPRINT_SAFE.test(fp) ? fp.slice(0, 200) : `fp-${scrub(fp, 80)}`);

/** Internal links only — never external URLs (could carry tokens/PII). */
function safeLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const l = link.trim();
  return l.startsWith("/system/") && l.length <= 300 && !/[\s"'<>]/.test(l) ? l : null;
}

export type AlertPayloadInput = {
  fingerprint: string;
  severity: AlertSeverity;
  title: string;
  body?: string;
  link?: string | null;
  test?: boolean;
};

/** Builds the sanitized outbound payload. Exported for tests. */
export function buildAlertPayload(input: AlertPayloadInput): { text: string; zapnivo: Record<string, unknown> } {
  const severity = input.severity === "critical" ? "critical" : input.severity === "info" ? "info" : "warning";
  const title = scrub(input.title, 200) || "Zapnivo alert";
  const body = scrub(input.body ?? "", 2000);
  const link = safeLink(input.link);
  const ts = new Date().toISOString();
  const text = `*${severity === "critical" ? "CRITICAL" : severity === "info" ? "Info" : "Warning"}* — ${title}${input.test ? " (TEST)" : ""}\n${body}${link ? `\n${link}` : ""}`.slice(0, 3500);
  return {
    text,
    zapnivo: {
      severity,
      key: safeFingerprint(input.fingerprint),
      title,
      body: body.slice(0, 2000),
      link,
      ts,
      ...(input.test ? { test: true } : {}),
    },
  };
}

export type WebhookPostResult = { attempted: number; delivered: number; failed: number; statuses: number[] };

/** POSTs one payload to each configured webhook URL. Never throws. */
export async function postAlertPayload(payload: ReturnType<typeof buildAlertPayload>, urls: string[] = alertWebhookUrls()): Promise<WebhookPostResult> {
  const result: WebhookPostResult = { attempted: urls.length, delivered: 0, failed: 0, statuses: [] };
  await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      result.statuses.push(res.status);
      if (res.ok) result.delivered += 1; else result.failed += 1;
      recordLog(res.ok ? "info" : "warning", "alert_notify_post", { service: "alerts", attrs: { status: res.status, ok: res.ok } });
    } catch (e) {
      result.failed += 1;
      recordLog("warning", "alert_notify_post_failed", { service: "alerts", attrs: { err: e instanceof Error ? e.message.slice(0, 120) : "unknown" } });
    }
  }));
  return result;
}

/** True when a 'sent' row for this fingerprint exists inside the dedup window. */
async function recentlySent(db: SupabaseClient, fingerprint: string, windowMinutes: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { data, error } = await db
    .from("alert_notifications")
    .select("id")
    .eq("fingerprint", fingerprint)
    .eq("status", "sent")
    .gte("sent_at", cutoff)
    .limit(1);
  if (error) return false; // ledger unavailable → do not block delivery
  return Array.isArray(data) && data.length > 0;
}

async function recordNotification(
  db: SupabaseClient,
  row: { fingerprint: string; kind: "alert" | "test"; severity: AlertSeverity; payload: unknown; status: "sent" | "failed" | "skipped"; detail?: string | null; sentAt?: string | null },
): Promise<void> {
  try {
    await db.from("alert_notifications").insert({
      fingerprint: row.fingerprint,
      kind: row.kind,
      severity: row.severity,
      payload: row.payload,
      status: row.status,
      detail: row.detail ? scrub(row.detail, 500) : null,
      sent_at: row.sentAt ?? null,
    });
  } catch { /* ledger is best-effort — never break alerting */ }
}

export type NotifyResult =
  | { ok: true; sent: boolean; deduped: boolean; configured: boolean; status: number }
  | { ok: false; error: string };

/**
 * Records + optionally posts an alert. Dedup: a 'sent' ledger row for the same
 * fingerprint inside `dedupMinutes` (default 6h) suppresses re-delivery.
 * `post:false` records the delivery decision only — used by the reportError
 * seam where externalAlert owns the actual POST (avoids double-posting).
 */
export async function notifyAlert(
  db: SupabaseClient,
  alert: AlertPayloadInput & { kind?: "alert" | "test" },
  opts: { dedupMinutes?: number; post?: boolean } = {},
): Promise<NotifyResult> {
  const fingerprint = safeFingerprint(alert.fingerprint);
  const severity: AlertSeverity = alert.severity === "critical" ? "critical" : alert.severity === "info" ? "info" : "warning";
  const payload = buildAlertPayload({ ...alert, fingerprint });
  const urls = alertWebhookUrls();
  const configured = urls.length > 0;
  const dedupMinutes = opts.dedupMinutes ?? 360;

  if (await recentlySent(db, fingerprint, dedupMinutes)) {
    return { ok: true, sent: false, deduped: true, configured, status: 0 };
  }

  if (!configured) {
    await recordNotification(db, {
      fingerprint, kind: alert.kind ?? "alert", severity, payload: payload.zapnivo,
      status: "skipped", detail: "ALERT_WEBHOOK_URL not configured",
    });
    return { ok: true, sent: false, deduped: false, configured: false, status: 0 };
  }

  if (opts.post === false) {
    // Delivery is owned by the caller's channel (externalAlert for the
    // reportError seam). Record it as sent so the ledger reflects reality.
    await recordNotification(db, {
      fingerprint, kind: alert.kind ?? "alert", severity, payload: payload.zapnivo,
      status: "sent", detail: "delivered via external_alert", sentAt: new Date().toISOString(),
    });
    return { ok: true, sent: true, deduped: false, configured: true, status: 0 };
  }

  const res = await postAlertPayload(payload, urls);
  const sent = res.delivered > 0;
  await recordNotification(db, {
    fingerprint, kind: alert.kind ?? "alert", severity, payload: payload.zapnivo,
    status: sent ? "sent" : "failed",
    detail: sent ? `http ${res.statuses.join(",")}` : `post failed (${res.failed}/${res.attempted})`,
    sentAt: sent ? new Date().toISOString() : null,
  });
  return { ok: true, sent, deduped: false, configured: true, status: res.statuses[0] ?? 0 };
}

/**
 * reportError-seam helper: mirrors an error-issue alert into the ledger.
 * externalAlert (called by alertNewIssue) performs the actual webhook POST —
 * this records configured?/sent/skipped honestly without double-posting.
 */
export async function notifyIssueAlert(
  db: SupabaseClient,
  alert: { fingerprint: string; severity: AlertSeverity; title: string; culprit?: string | null },
): Promise<void> {
  try {
    await notifyAlert(db, {
      fingerprint: `issue:${alert.fingerprint}`,
      kind: "alert",
      severity: alert.severity,
      title: alert.title,
      body: `Route: ${alert.culprit ?? "unknown"}\nFingerprint: ${alert.fingerprint}`,
      link: "/system/observability/errors",
    }, { post: false, dedupMinutes: 360 });
  } catch { /* best-effort */ }
}

/** Delivery status for the observability console. */
export type AlertDeliveryStatus = {
  configured: boolean;
  webhookEnv: "ALERT_WEBHOOK_URL";
  storeAvailable: boolean;
  sent24h: number;
  failed24h: number;
  skipped24h: number;
  lastSentAt: string | null;
  lastFailureAt: string | null;
  recent: AlertNotificationRow[];
};

export async function getAlertDeliveryStatus(db: SupabaseClient | null): Promise<AlertDeliveryStatus> {
  const base: AlertDeliveryStatus = {
    configured: alertWebhookUrls().length > 0,
    webhookEnv: "ALERT_WEBHOOK_URL",
    storeAvailable: false,
    sent24h: 0, failed24h: 0, skipped24h: 0,
    lastSentAt: null, lastFailureAt: null,
    recent: [],
  };
  if (!db) return base;
  const since24 = new Date(Date.now() - 86_400_000).toISOString();
  const { data, error } = await db
    .from("alert_notifications")
    .select("id,fingerprint,kind,severity,status,detail,sent_at,created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return base; // table may not exist pre-0068 — honest empty state
  base.storeAvailable = true;
  const rows = (data ?? []) as AlertNotificationRow[];
  base.recent = rows.slice(0, 10);
  for (const r of rows) {
    if (r.status === "sent") {
      base.sent24h += r.created_at >= since24 ? 1 : 0;
      if (!base.lastSentAt || (r.sent_at ?? r.created_at) > base.lastSentAt) base.lastSentAt = r.sent_at ?? r.created_at;
    } else if (r.status === "failed") {
      base.failed24h += r.created_at >= since24 ? 1 : 0;
      if (!base.lastFailureAt || r.created_at > base.lastFailureAt) base.lastFailureAt = r.created_at;
    } else {
      base.skipped24h += r.created_at >= since24 ? 1 : 0;
    }
  }
  return base;
}

export type TestAlertResult =
  | { ok: true; configured: true; delivered: boolean; status: number; notificationId: string | null }
  | { ok: false; error: string };

/**
 * Sends a clearly-marked test alert to the configured webhook and records the
 * result. Bypasses dedup (kind='test', unique fingerprint per call is NOT
 * used — fingerprint stays 'test-alert' but dedup is skipped for tests so the
 * button always exercises the real path).
 */
export async function sendTestAlert(
  db: SupabaseClient,
  actor: SystemActor,
): Promise<TestAlertResult> {
  const urls = alertWebhookUrls();
  if (urls.length === 0) return { ok: false, error: "ALERT_WEBHOOK_URL is not configured — no webhook destination to test." };

  const fingerprint = `test-alert:${actor.id.slice(0, 8)}`;
  const payload = buildAlertPayload({
    fingerprint,
    severity: "info",
    title: "Zapnivo alert delivery test",
    body: "This is a test alert sent from system.zapnivo.com → Observability → Alerts. If you can read this, ALERT_WEBHOOK_URL delivery is working.",
    link: "/system/observability/alerts",
    test: true,
  });
  const res = await postAlertPayload(payload, urls);
  const sent = res.delivered > 0;

  let notificationId: string | null = null;
  try {
    const { data } = await db.from("alert_notifications").insert({
      fingerprint,
      kind: "test",
      severity: "info",
      payload: payload.zapnivo,
      status: sent ? "sent" : "failed",
      detail: sent ? `http ${res.statuses.join(",")}` : `post failed (${res.failed}/${res.attempted})`,
      sent_at: sent ? new Date().toISOString() : null,
    }).select("id").single();
    notificationId = (data as { id?: string } | null)?.id ?? null;
  } catch { /* ledger best-effort */ }

  await systemAudit(db, {
    actor,
    action: "observability.alert_test",
    resource: "alert_notifications:test",
    detail: { delivered: sent, attempted: res.attempted, failed: res.failed, statuses: res.statuses.slice(0, 5) },
  });

  return { ok: true, configured: true, delivered: sent, status: res.statuses[0] ?? 0, notificationId };
}
