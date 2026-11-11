import { recordLog } from "./observability";

/**
 * External alert fallback — used when the primary path (in-app incident +
 * Brevo email outbox) may itself be down.
 *
 * Configure ALERT_WEBHOOK_URL to any endpoint accepting a JSON POST.
 * Slack-compatible webhooks work: we send { text, attachments } plus a
 * structured `zapnivo` object. healthchecks.io-style dead-man pings are a
 * different mechanism — this is push alerting.
 *
 * Storm prevention: per-key cooldown (default 15 min, ALERT_COOLDOWN_MS to
 * override) held in-process; across serverless instances the webhook target
 * is expected to do its own dedup/rate limiting.
 */

const cooldown = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export function externalAlert(key: string, title: string, body: string, severity: "warning" | "critical" = "critical"): void {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return; // not configured → no-op (primary pipeline still runs)
  const now = Date.now();
  const last = cooldown.get(key) ?? 0;
  const cd = Number(process.env.ALERT_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS;
  if (now - last < cd) return;
  cooldown.set(key, now);

  const text = `*${severity === "critical" ? "CRITICAL" : "Warning"}* — ${title}\n${body}`.slice(0, 3500);
  void fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      zapnivo: { severity, key, title, body: body.slice(0, 2000), ts: new Date(now).toISOString() },
    }),
  }).then((r) => {
    recordLog(r.ok ? "info" : "warning", "external_alert_delivered", { service: "alerts", attrs: { key, status: r.status } });
  }).catch((e) => {
    recordLog("warning", "external_alert_failed", { service: "alerts", attrs: { key, err: e instanceof Error ? e.message.slice(0, 120) : "unknown" } });
  });
}
