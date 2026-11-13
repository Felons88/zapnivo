import type { SupabaseClient } from "@supabase/supabase-js";
import { scrub } from "@/lib/observability";
import { sanitizeAuditDetail } from "./audit";

/**
 * Infrastructure webhook inspector for /system/infrastructure/webhooks.
 *
 * Aggregates EVERY inbound/event surface — broader than lib/system/webhooks.ts
 * (which covers the customer-facing sources): adds system_device_messages
 * (device HMAC auth telemetry) and email_outbox (outbound queue failures).
 *
 * Hard rules:
 *  - Whitelisted columns only. PII columns (emails, phone numbers, bodies,
 *    subjects) are NEVER selected.
 *  - jsonb `detail`/`payload` columns are only surfaced through
 *    sanitizeAuditDetail (drops secret-ish keys, scrubs strings) — and for
 *    inbound_jobs.payload only an explicit non-PII allowlist is shown, since
 *    the payload is a parsed inbound email (from/subject/text/recipients).
 *  - Replay is NOT implemented here — the UI reuses the existing audited
 *    endpoints (/api/system/webhooks/[ref]/replay for inbound_jobs,
 *    /api/system/jobs/email-outbox/[id]/retry for email_outbox). Payment
 *    events (stripe_events) have no replay path at all.
 */

export const INFRA_WEBHOOK_SOURCES = [
  "stripe_events",
  "inbound_jobs",
  "inbound_emails",
  "sms_messages",
  "system_device_messages",
  "email_outbox",
] as const;
export type InfraWebhookSourceId = (typeof INFRA_WEBHOOK_SOURCES)[number];

export type SourceStats = {
  id: InfraWebhookSourceId;
  provider: string;
  endpoint: string;
  description: string;
  /** Events received in the trailing 24h (by the source's event-time column). */
  events24h: number | null;
  /** Currently pending/in-flight work, where the concept applies. */
  pending: number | null;
  /** Failure/dead/quarantined count in trailing 24h; null = not tracked. */
  failures24h: number | null;
  lastEventAt: string | null;
  /** Last known-good processing timestamp; null when the source has no such signal. */
  lastSuccessAt: string | null;
  note: string;
};

export type InfraEvent = {
  /** `${source}:${rowId}` — matches the existing /api/system/webhooks inspector ref format where applicable. */
  ref: string;
  source: InfraWebhookSourceId;
  at: string | null;
  status: string;
  /** Sanitized, whitelisted fields only. */
  fields: Record<string, unknown>;
};

export type ReplayEligibility =
  | { eligible: true; kind: "inbound_job" | "outbox_email"; ref: string }
  | { eligible: false; reason: string };

export type WebhookInspectorReport = {
  configured: boolean;
  generatedAt: string;
  sources: SourceStats[];
  /** Latest few events per source (bounded), newest first overall. */
  recent: InfraEvent[];
  /** Recent quarantined inbound_emails rows — read-only quarantine view. */
  quarantine: InfraEvent[];
};

const DAY_MS = 24 * 3600_000;
const sinceIso = () => new Date(Date.now() - DAY_MS).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Filterable = any;

async function headCount(db: SupabaseClient, table: string, apply?: (q: Filterable) => Filterable): Promise<number | null> {
  try {
    let q = db.from(table).select("id", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

async function lastAt(db: SupabaseClient, table: string, column: string, apply?: (q: Filterable) => Filterable): Promise<string | null> {
  try {
    let q = db.from(table).select(column).order(column, { ascending: false }).limit(1);
    if (apply) q = apply(q);
    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    return (data as unknown as Record<string, unknown>)[column] as string | null;
  } catch {
    return null;
  }
}

const num = (v: number | null) => v ?? 0;
const add = (a: number | null, b: number) => (a == null ? null : a + b);

/* ── Per-source stat gathering ──────────────────────────────────────────── */

async function gatherStats(db: SupabaseClient): Promise<SourceStats[]> {
  const since = sinceIso();
  const [
    stripe24, stripeLast,
    job24, jobQueued, jobProcessing, jobDead24, jobDoneLast,
    mail24, mailAccepted24, mailQuar24, mailLastOk,
    sms24, smsFail24, smsLastOk,
    dev24, devRejected24, devOkLast,
    outQueued, outSent24, outFailed24, outLastOk,
  ] = await Promise.all([
    headCount(db, "stripe_events", (q) => q.gte("received_at", since)),
    lastAt(db, "stripe_events", "received_at"),
    headCount(db, "inbound_jobs", (q) => q.gte("created_at", since)),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "queued")),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "processing")),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "dead").gte("created_at", since)),
    lastAt(db, "inbound_jobs", "processed_at", (q) => q.eq("status", "done")),
    headCount(db, "inbound_emails", (q) => q.gte("created_at", since)),
    headCount(db, "inbound_emails", (q) => q.eq("status", "accepted").gte("created_at", since)),
    headCount(db, "inbound_emails", (q) => q.eq("status", "quarantined").gte("created_at", since)),
    lastAt(db, "inbound_emails", "created_at", (q) => q.eq("status", "accepted")),
    headCount(db, "sms_messages", (q) => q.gte("created_at", since)),
    headCount(db, "sms_messages", (q) => q.in("status", ["failed", "undelivered"]).gte("created_at", since)),
    lastAt(db, "sms_messages", "created_at", (q) => q.in("status", ["sent", "delivered"])),
    headCount(db, "system_device_messages", (q) => q.gte("received_at", since)),
    headCount(db, "system_device_messages", (q) => q.eq("result", "rejected").gte("received_at", since)),
    lastAt(db, "system_device_messages", "received_at", (q) => q.eq("result", "ok")),
    headCount(db, "email_outbox", (q) => q.eq("status", "queued")),
    headCount(db, "email_outbox", (q) => q.eq("status", "sent").gte("created_at", since)),
    headCount(db, "email_outbox", (q) => q.eq("status", "failed").gte("created_at", since)),
    lastAt(db, "email_outbox", "created_at", (q) => q.eq("status", "sent")),
  ]);

  return [
    {
      id: "stripe_events", provider: "stripe", endpoint: "/api/webhooks/stripe",
      description: "Payment webhook dedupe ledger. Only id/type/received_at are stored — failed handlers delete the row so Stripe retries; per-event failure detail lives in app_logs.",
      events24h: stripe24, pending: null, failures24h: null,
      lastEventAt: stripeLast, lastSuccessAt: stripeLast,
      note: "No replay path — payloads are not stored. Re-send from the Stripe dashboard if needed.",
    },
    {
      id: "inbound_jobs", provider: "inbound-worker", endpoint: "/api/webhooks/email/inbound → /api/cron/inbound",
      description: "Durable inbound-email job queue. 'dead' = exhausted retries (dead-letter).",
      events24h: job24, pending: add(jobQueued, num(jobProcessing)), failures24h: jobDead24,
      lastEventAt: null, lastSuccessAt: jobDoneLast,
      note: "failed/dead rows are requeueable via the audited replay endpoint (worker dedupes on message_id).",
    },
    {
      id: "inbound_emails", provider: "brevo", endpoint: "/api/webhooks/email/inbound",
      description: "Inbound mail processing log — includes quarantined mail (auth/validation failures).",
      events24h: mail24, pending: null, failures24h: mailQuar24,
      lastEventAt: null, lastSuccessAt: mailLastOk,
      note: "failures24h counts quarantined rows in 24h. Quarantine is read-only here — release/reject happens in the helpdesk flow.",
    },
    {
      id: "sms_messages", provider: "twilio", endpoint: "/api/webhooks/twilio",
      description: "Inbound SMS + Twilio delivery-status callbacks (STOP/START opt-outs handled inline).",
      events24h: sms24, pending: null, failures24h: smsFail24,
      lastEventAt: null, lastSuccessAt: smsLastOk,
      note: "failed/undelivered statuses counted for 24h. Numbers and bodies are never selected.",
    },
    {
      id: "system_device_messages", provider: "kiosk_hmac", endpoint: "/api/devices/events",
      description: "Append-only device-auth telemetry — one row per ingest attempt (HMAC or legacy shared secret).",
      events24h: dev24, pending: null, failures24h: devRejected24,
      lastEventAt: null, lastSuccessAt: devOkLast,
      note: "result='rejected' counted as failure. detail jsonb shown only after sanitizeAuditDetail.",
    },
    {
      id: "email_outbox", provider: "mailer", endpoint: "outbound (Brevo/Resend flush)",
      description: "Outbound email queue. 'failed' rows can be requeued via the audited retry endpoint.",
      events24h: null, pending: outQueued, failures24h: outFailed24,
      lastEventAt: null, lastSuccessAt: outLastOk,
      note: "events24h not meaningful for a queue — sent/failed counts cover the trailing 24h. Recipients/subjects/bodies never selected.",
    },
  ];
}

/* ── Recent event lists (whitelisted columns only) ──────────────────────── */

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

async function recentEvents(db: SupabaseClient): Promise<InfraEvent[]> {
  const events: InfraEvent[] = [];
  const push = (e: InfraEvent) => events.push(e);

  const [stripe, jobs, mails, sms, devs, outbox] = await Promise.all([
    db.from("stripe_events").select("id,type,received_at").order("received_at", { ascending: false }).limit(8),
    db.from("inbound_jobs").select("id,kind,status,attempts,max_attempts,run_after,last_error,message_id,created_at,processed_at,payload").order("created_at", { ascending: false }).limit(8),
    db.from("inbound_emails").select("id,message_id,status,reason,auth_method,dmarc_result,spf_result,dkim_result,processed_ms,created_at").order("created_at", { ascending: false }).limit(8),
    db.from("sms_messages").select("id,direction,status,provider_sid,created_at").order("created_at", { ascending: false }).limit(8),
    db.from("system_device_messages").select("id,device_id,message_type,auth_method,result,detail,received_at").order("received_at", { ascending: false }).limit(8),
    db.from("email_outbox").select("id,status,sender,error,created_at").order("created_at", { ascending: false }).limit(8),
  ]);

  for (const r of (stripe.data ?? []) as Record<string, unknown>[]) {
    push({
      ref: `stripe_events:${r.id}`, source: "stripe_events", at: (r.received_at as string) ?? null, status: "recorded",
      fields: { id: r.id, type: r.type, receivedAt: r.received_at },
    });
  }
  for (const r of (jobs.data ?? []) as Record<string, unknown>[]) {
    push({
      ref: `inbound_jobs:${r.id}`, source: "inbound_jobs", at: (r.created_at as string) ?? null, status: String(r.status ?? ""),
      fields: {
        id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts,
        runAfter: r.run_after, lastError: scrub(String(r.last_error ?? ""), 300) || null,
        messageId: r.message_id, createdAt: r.created_at, processedAt: r.processed_at,
        payloadSummary: inboundJobPayloadSummary(r.payload),
      },
    });
  }
  for (const r of (mails.data ?? []) as Record<string, unknown>[]) {
    push({
      ref: `inbound_emails:${r.id}`, source: "inbound_emails", at: (r.created_at as string) ?? null, status: String(r.status ?? ""),
      fields: {
        id: r.id, messageId: r.message_id, status: r.status,
        reason: scrub(String(r.reason ?? ""), 200) || null,
        authMethod: r.auth_method, dmarc: r.dmarc_result, spf: r.spf_result, dkim: r.dkim_result,
        processedMs: numOrNull(r.processed_ms), createdAt: r.created_at,
      },
    });
  }
  for (const r of (sms.data ?? []) as Record<string, unknown>[]) {
    push({
      ref: `sms_messages:${r.id}`, source: "sms_messages", at: (r.created_at as string) ?? null, status: String(r.status ?? ""),
      fields: { id: r.id, direction: r.direction, status: r.status, providerSid: r.provider_sid, createdAt: r.created_at },
    });
  }
  for (const r of (devs.data ?? []) as Record<string, unknown>[]) {
    push({
      ref: `system_device_messages:${r.id}`, source: "system_device_messages", at: (r.received_at as string) ?? null, status: String(r.result ?? ""),
      fields: {
        id: r.id, deviceId: r.device_id, messageType: r.message_type, authMethod: r.auth_method,
        result: r.result, receivedAt: r.received_at,
        detail: r.detail && typeof r.detail === "object" ? sanitizeAuditDetail(r.detail as Record<string, unknown>) : null,
      },
    });
  }
  for (const r of (outbox.data ?? []) as Record<string, unknown>[]) {
    push({
      ref: `email_outbox:${r.id}`, source: "email_outbox", at: (r.created_at as string) ?? null, status: String(r.status ?? ""),
      fields: {
        id: r.id, status: r.status, sender: r.sender,
        error: scrub(String(r.error ?? ""), 300) || null, createdAt: r.created_at,
      },
    });
  }

  return events.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

async function quarantineEvents(db: SupabaseClient): Promise<InfraEvent[]> {
  try {
    const { data } = await db
      .from("inbound_emails")
      .select("id,message_id,status,reason,auth_method,dmarc_result,spf_result,dkim_result,created_at")
      .eq("status", "quarantined")
      .order("created_at", { ascending: false })
      .limit(10);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      ref: `inbound_emails:${r.id}`, source: "inbound_emails" as const,
      at: (r.created_at as string) ?? null, status: "quarantined",
      fields: {
        id: r.id, messageId: r.message_id, reason: scrub(String(r.reason ?? ""), 200) || null,
        authMethod: r.auth_method, dmarc: r.dmarc_result, spf: r.spf_result, dkim: r.dkim_result,
        createdAt: r.created_at,
      },
    }));
  } catch {
    return [];
  }
}

/**
 * inbound_jobs.payload is a parsed inbound email (Parsed: from/subject/text/
 * recipients/…). PII fields are withheld entirely; only auth results and ids
 * are surfaced — every value still passes through sanitizeAuditDetail.
 */
const JOB_PAYLOAD_SAFE_KEYS = ["messageId", "inReplyTo", "dmarc", "spf", "dkim", "autoSubmitted"] as const;
const JOB_PAYLOAD_WITHHELD = ["from", "subject", "text", "recipients", "body", "html", "to", "sender", "cc"] as const;

export function inboundJobPayloadSummary(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { note: "no payload" };
  const p = payload as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const k of JOB_PAYLOAD_SAFE_KEYS) {
    if (p[k] !== undefined) safe[k] = p[k];
  }
  const sanitized = sanitizeAuditDetail(safe);
  return {
    ...sanitized,
    withheld: [...JOB_PAYLOAD_WITHHELD],
    note: "email content (from/subject/text/recipients) withheld — PII. Auth results and ids only.",
  };
}

/** Full inspector report for the page + GET /api/system/infrastructure/webhooks. */
export async function getWebhookInspector(db: SupabaseClient | null): Promise<WebhookInspectorReport> {
  const empty: WebhookInspectorReport = {
    configured: false, generatedAt: new Date().toISOString(), sources: [], recent: [], quarantine: [],
  };
  if (!db) return empty;
  const [sources, recent, quarantine] = await Promise.all([gatherStats(db), recentEvents(db), quarantineEvents(db)]);
  return { configured: true, generatedAt: new Date().toISOString(), sources, recent, quarantine };
}

/* ── Detail view ────────────────────────────────────────────────────────── */

export type InspectDetail =
  | { ok: true; event: InfraEvent; replay: ReplayEligibility }
  | { ok: false; status: number; error: string };

/** Replay mapping — reuses EXISTING audited endpoints; nothing new is built. */
export function replayEligibility(source: InfraWebhookSourceId, row: Record<string, unknown>): ReplayEligibility {
  const id = String(row.id ?? "");
  if (source === "inbound_jobs" && (row.status === "failed" || row.status === "dead")) {
    return { eligible: true, kind: "inbound_job", ref: `inbound_jobs:${id}` };
  }
  if (source === "inbound_jobs") {
    return { eligible: false, reason: `job status is "${String(row.status)}" — only failed/dead jobs can be requeued` };
  }
  if (source === "email_outbox" && row.status === "failed") {
    return { eligible: true, kind: "outbox_email", ref: `email_outbox:${id}` };
  }
  if (source === "email_outbox") {
    return { eligible: false, reason: `outbox status is "${String(row.status)}" — only failed rows can be retried` };
  }
  return { eligible: false, reason: `${source} has no replay path — provider re-send or manual remediation only` };
}

const DETAIL_SELECT: Record<InfraWebhookSourceId, string> = {
  stripe_events: "id,type,received_at",
  inbound_jobs: "id,kind,status,attempts,max_attempts,run_after,last_error,message_id,created_at,processed_at,payload",
  inbound_emails: "id,message_id,status,reason,auth_method,dmarc_result,spf_result,dkim_result,processed_ms,created_at",
  sms_messages: "id,direction,status,provider_sid,created_at",
  system_device_messages: "id,device_id,message_type,auth_method,result,detail,received_at",
  email_outbox: "id,status,sender,error,created_at",
};

/** Single-event detail — sanitized fields + replay eligibility. Never selects PII columns. */
export async function inspectInfraEvent(
  db: SupabaseClient,
  source: InfraWebhookSourceId,
  rowId: string,
): Promise<InspectDetail> {
  if (!(INFRA_WEBHOOK_SOURCES as readonly string[]).includes(source) || !rowId || rowId.length > 100) {
    return { ok: false, status: 400, error: "Invalid source or row id" };
  }
  const { data, error } = await db.from(source).select(DETAIL_SELECT[source]).eq("id", rowId).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Event not found" };
  const r = data as unknown as Record<string, unknown>;

  const fields: Record<string, unknown> = {};
  switch (source) {
    case "stripe_events":
      fields.id = r.id; fields.type = r.type; fields.receivedAt = r.received_at;
      break;
    case "inbound_jobs":
      fields.id = r.id; fields.kind = r.kind; fields.status = r.status;
      fields.attempts = r.attempts; fields.maxAttempts = r.max_attempts;
      fields.runAfter = r.run_after;
      fields.lastError = scrub(String(r.last_error ?? ""), 300) || null;
      fields.messageId = r.message_id; fields.createdAt = r.created_at; fields.processedAt = r.processed_at;
      fields.payloadSummary = inboundJobPayloadSummary(r.payload);
      break;
    case "inbound_emails":
      fields.id = r.id; fields.messageId = r.message_id; fields.status = r.status;
      fields.reason = scrub(String(r.reason ?? ""), 200) || null;
      fields.authMethod = r.auth_method; fields.dmarc = r.dmarc_result;
      fields.spf = r.spf_result; fields.dkim = r.dkim_result;
      fields.processedMs = numOrNull(r.processed_ms); fields.createdAt = r.created_at;
      break;
    case "sms_messages":
      fields.id = r.id; fields.direction = r.direction; fields.status = r.status;
      fields.providerSid = r.provider_sid; fields.createdAt = r.created_at;
      break;
    case "system_device_messages":
      fields.id = r.id; fields.deviceId = r.device_id; fields.messageType = r.message_type;
      fields.authMethod = r.auth_method; fields.result = r.result; fields.receivedAt = r.received_at;
      fields.detail = r.detail && typeof r.detail === "object" ? sanitizeAuditDetail(r.detail as Record<string, unknown>) : null;
      break;
    case "email_outbox":
      fields.id = r.id; fields.status = r.status; fields.sender = r.sender;
      fields.error = scrub(String(r.error ?? ""), 300) || null; fields.createdAt = r.created_at;
      break;
  }

  const at =
    (r.received_at as string | undefined) ??
    (r.created_at as string | undefined) ??
    (r.processed_at as string | undefined) ??
    null;
  const event: InfraEvent = {
    ref: `${source}:${r.id}`, source, at, status: String(fields.status ?? fields.result ?? "recorded"), fields,
  };
  return { ok: true, event, replay: replayEligibility(source, r) };
}
