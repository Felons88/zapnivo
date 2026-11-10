import { serviceClient } from "./supabase";

/** Stable non-cryptographic hash (FNV-1a x3) — edge-runtime safe, no node:crypto. */
function hashHex(input: string, seed: number): string {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function hash24(input: string): string {
  return hashHex(input, 0) + hashHex(input, 0x9e3779b9) + hashHex(input, 0x85ebca6b);
}

/**
 * Zapnivo Observability — internal telemetry SDK.
 * Fail-open by design: telemetry must never break a request. All writes go through
 * the service role; all payloads are scrubbed of secrets/PII before storage.
 */

export type Severity = "error" | "critical" | "warning";
export type Level = "debug" | "info" | "warning" | "error" | "critical";

const ENV = () => process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
const RELEASE = () => process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "dev";

/* ── Scrubbing ─────────────────────────────────────────────────────────── */

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|bearer|cookie|session|otp|code)["'\s:=]+[^\s"',}]{6,}/gi,
  /sk-[a-zA-Z0-9_-]{8,}/g, /whsec_[a-zA-Z0-9]+/g, /SG\.[a-zA-Z0-9_.-]+/g,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,                       // card numbers
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,                                   // emails
  /\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,              // US phones
];

export function scrub(input: string | null | undefined, max = 4000): string {
  if (!input) return "";
  let s = String(input).slice(0, max * 2);
  for (const re of SECRET_PATTERNS) s = s.replace(re, (m) => (m.includes("@") ? "[email]" : /\d{3}[-.\s]?\d{4}/.test(m) && m.replace(/\D/g, "").length === 10 ? "[phone]" : "[redacted]"));
  return s.slice(0, max);
}

export function scrubAttrs(input: unknown): Record<string, string | number | boolean> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>).slice(0, 20)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,50}$/.test(k)) continue;
    if (/pass|secret|token|key|auth|cookie|otp|card|cvv|ssn/i.test(k)) continue;
    if (typeof v === "string") out[k] = scrub(v, 300);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

/* ── Fingerprinting ────────────────────────────────────────────────────── */

/** Stable issue key: exception type + first meaningful stack frame + route. */
export function fingerprint(parts: { name?: string; message?: string; stack?: string; route?: string }): string {
  const frame = (parts.stack ?? "")
    .split("\n").map((l) => l.trim())
    .find((l) => /\.(tsx?|jsx?)|app\/|src\//.test(l) && !/node_modules/.test(l)) ?? "";
  const norm = `${parts.name ?? "Error"}|${(parts.message ?? "").slice(0, 120)}|${frame.replace(/\(?[^)\s]+:\d+:\d+\)?/, "").slice(0, 160)}|${parts.route ?? ""}`;
  return hash24(norm);
}

/* ── Server-side capture ───────────────────────────────────────────────── */

export function reportError(err: unknown, ctx: { route?: string; severity?: Severity; attrs?: Record<string, unknown> } = {}): void {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const db = serviceClient();
    if (!db) return;
    const fp = fingerprint({ name: e.name, message: e.message, stack: e.stack, route: ctx.route });
    void db.from("error_events").insert({
      fingerprint: fp,
      title: `${e.name}: ${scrub(e.message, 200)}`,
      message: scrub(e.message),
      stack: scrub(e.stack, 8000),
      route: ctx.route ?? null,
      release: RELEASE(),
      environment: ENV(),
      runtime: "server",
      severity: ctx.severity ?? "error",
      user_agent: null,
    }).then(async ({ error }) => {
      if (error) return;
      // Upsert the grouped issue; alert only when this is a genuinely new fingerprint.
      const { data: existing } = await db.from("error_issues").select("id,status,first_seen").eq("fingerprint", fp).maybeSingle();
      const now = new Date().toISOString();
      if (existing) {
        const wasResolved = (existing as { status: string }).status === "resolved";
        await db.from("error_issues").update({
          last_seen: now, event_count: ((existing as { event_count?: number }).event_count ?? 0) + 1,
          ...(wasResolved ? { status: "regressed", resolved_at: null } : {}),
        }).eq("fingerprint", fp);
        return;
      }
      const { data: issue } = await db.from("error_issues").insert({
        fingerprint: fp, title: `${e.name}: ${scrub(e.message, 160)}`, culprit: ctx.route ?? null,
        severity: ctx.severity ?? "error", first_seen: now, last_seen: now, event_count: 1,
      }).select("id").single();
      if (ctx.severity === "critical" && issue) void alertNewIssue(db, issue.id as string, fp);
    }).then(() => undefined, () => undefined);
  } catch { /* fail-open */ }
}

async function alertNewIssue(db: NonNullable<ReturnType<typeof serviceClient>>, issueId: string, fp: string) {
  try {
    const { data: issue } = await db.from("error_issues").select("title,culprit").eq("id", issueId).maybeSingle();
    const i = issue as { title?: string; culprit?: string } | null;
    // Reuse the staff alert pipeline (email outbox → Brevo).
    const { alertStaff } = await import("./fleet-sweep");
    await alertStaff(db, "offline_alerts", `Critical error: ${i?.title ?? fp}`, `A new critical error was captured.\n\n${i?.title ?? ""}\nRoute: ${i?.culprit ?? "unknown"}\nFingerprint: ${fp}\n\nReview in Admin → Observability.`, null, { sender: "operations", event: "ops.critical_error" });
  } catch { /* alerting is best-effort */ }
}

export function recordLog(level: Level, message: string, ctx: { service?: string; route?: string; traceId?: string; attrs?: Record<string, unknown> } = {}): void {
  try {
    const db = serviceClient();
    if (!db) return;
    void db.from("app_logs").insert({
      level, service: ctx.service ?? "web", message: scrub(message, 1000), route: ctx.route ?? null,
      trace_id: ctx.traceId ?? null, attrs: scrubAttrs(ctx.attrs),
    }).then(() => undefined, () => undefined);
  } catch { /* fail-open */ }
}

export function recordSpan(span: { traceId: string; spanId?: string; parentSpanId?: string; name: string; service?: string; kind?: string; startMs: number; durationMs: number; status?: string; attrs?: Record<string, unknown> }): void {
  try {
    const db = serviceClient();
    if (!db || span.durationMs < 0 || span.durationMs > 10 * 60_000) return;
    void db.from("trace_spans").insert({
      trace_id: span.traceId.slice(0, 64),
      parent_span_id: span.parentSpanId?.slice(0, 64) ?? null,
      span_id: (span.spanId ?? hash24(`${span.traceId}:${span.name}:${span.startMs}`).slice(0, 16)),
      name: scrub(span.name, 120), service: span.service ?? "web", kind: span.kind ?? "internal",
      start_ms: span.startMs, duration_ms: span.durationMs, status: span.status ?? "ok",
      attrs: scrubAttrs(span.attrs),
    }).then(() => undefined, () => undefined);
  } catch { /* fail-open */ }
}

/** Times an async operation and records a span. Usage: await traced("db.lookup", tid, () => fn()). */
export async function traced<T>(name: string, traceId: string | null | undefined, fn: () => Promise<T>, attrs?: Record<string, unknown>): Promise<T> {
  const tid = traceId ?? hash24(`${Date.now()}:${Math.random()}`).slice(0, 32);
  const start = performance.now();
  try {
    const out = await fn();
    recordSpan({ traceId: tid, name, startMs: start, durationMs: performance.now() - start, attrs });
    return out;
  } catch (e) {
    recordSpan({ traceId: tid, name, startMs: start, durationMs: performance.now() - start, status: "error", attrs });
    throw e;
  }
}
