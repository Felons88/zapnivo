import type { SupabaseClient } from "@supabase/supabase-js";
import { scrub } from "@/lib/observability";
import { assertApprovedOrRequest, systemAudit, type SystemActor } from "./audit";
import { inboundJobPayloadSummary, relatedBusinessObject, signatureVerification } from "./webhook-inspector";

/**
 * Webhook/event-source aggregation + inspector + replay for the system console.
 *
 * Sources are the REAL tables written by the webhook/ingest routes:
 *   stripe_events      — /api/webhooks/stripe (dedupe ledger; failures delete the
 *                        row so Stripe retries — there is no status column)
 *   inbound_emails     — /api/webhooks/email/inbound (log of accepted/quarantined mail)
 *   inbound_jobs       — durable queue drained by /api/cron/inbound
 *   sms_messages       — /api/webhooks/twilio (inbound SMS + delivery callbacks)
 *   kiosk_events       — /api/devices/events ingest ledger (processed_at stamped)
 *
 * The inspector returns sanitized metadata only — never raw payloads (PII).
 * Replay is ONLY supported for inbound_jobs rows in failed/dead state: requeueing
 * is safe because the worker dedupes on message_id/dedupe_hash. Stripe events
 * cannot be replayed (the payload is not stored and fulfillment is not blindly
 * re-runnable) → honest 409 replay_unsupported.
 */

export type WebhookSourceId = "stripe_events" | "inbound_emails" | "inbound_jobs" | "sms_messages" | "kiosk_events";
export const WEBHOOK_SOURCES: readonly WebhookSourceId[] = ["stripe_events", "inbound_emails", "inbound_jobs", "sms_messages", "kiosk_events"];

export type WebhookRow = {
  /** `${source}:${rowId}` — used by the inspector/replay endpoints. */
  ref: string | null;
  source: WebhookSourceId;
  provider: string;
  endpoint: string;
  lastEventAt: string | null;
  counts: Record<string, number>;
  pending: number | null;
  failures24h: number | null;
  note: string | null;
};

const DAY_MS = 24 * 3600_000;

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

async function lastAt(db: SupabaseClient, table: string, column: string): Promise<string | null> {
  try {
    const { data, error } = await db.from(table).select(column).order(column, { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return (data as unknown as Record<string, unknown>)[column] as string | null;
  } catch {
    return null;
  }
}

/** Aggregates per-source stats. All queries are head counts / single-row reads. */
export async function listWebhookSources(db: SupabaseClient | null): Promise<WebhookRow[]> {
  if (!db) return [];
  const since = new Date(Date.now() - DAY_MS).toISOString();

  const [
    stripeTotal, stripeLast,
    inbMailLast, inbMailAccepted, inbMailQuarantined, inbMailRejected, inbMailIgnored, inbMailDuplicate, inbMailError, inbMailErr24,
    jobLast, jobQueued, jobProcessing, jobDone, jobFailed, jobDead, jobFail24,
    smsLast, smsInbound, smsOutbound, smsFailed24,
    kioLast, kioUnprocessed, kioProcessed, kioRejected24,
  ] = await Promise.all([
    headCount(db, "stripe_events"), lastAt(db, "stripe_events", "received_at"),
    lastAt(db, "inbound_emails", "created_at"),
    headCount(db, "inbound_emails", (q) => q.eq("status", "accepted")),
    headCount(db, "inbound_emails", (q) => q.eq("status", "quarantined")),
    headCount(db, "inbound_emails", (q) => q.eq("status", "rejected")),
    headCount(db, "inbound_emails", (q) => q.eq("status", "ignored")),
    headCount(db, "inbound_emails", (q) => q.eq("status", "duplicate")),
    headCount(db, "inbound_emails", (q) => q.eq("status", "error")),
    headCount(db, "inbound_emails", (q) => q.eq("status", "error").gte("created_at", since)),
    lastAt(db, "inbound_jobs", "created_at"),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "queued")),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "processing")),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "done")),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "failed")),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "dead")),
    headCount(db, "inbound_jobs", (q) => q.in("status", ["failed", "dead"]).gte("created_at", since)),
    lastAt(db, "sms_messages", "created_at"),
    headCount(db, "sms_messages", (q) => q.eq("direction", "inbound")),
    headCount(db, "sms_messages", (q) => q.eq("direction", "outbound")),
    headCount(db, "sms_messages", (q) => q.in("status", ["failed", "undelivered"]).gte("created_at", since)),
    lastAt(db, "kiosk_events", "received_at"),
    headCount(db, "kiosk_events", (q) => q.is("processed_at", null)),
    headCount(db, "kiosk_events", (q) => q.not("processed_at", "is", null)),
    headCount(db, "kiosk_events", (q) => q.like("result", "rejected%").gte("received_at", since)),
  ]);

  const num = (v: number | null) => v ?? 0;
  return [
    {
      ref: null, source: "stripe_events", provider: "stripe", endpoint: "/api/webhooks/stripe",
      lastEventAt: stripeLast,
      counts: { received: num(stripeTotal) },
      pending: null, failures24h: null,
      note: "Dedupe ledger only — failed handlers delete the row so Stripe retries. Failure detail lives in app_logs (stripe_event_failed).",
    },
    {
      ref: null, source: "inbound_emails", provider: "brevo", endpoint: "/api/webhooks/email/inbound",
      lastEventAt: inbMailLast,
      counts: {
        accepted: num(inbMailAccepted), quarantined: num(inbMailQuarantined), rejected: num(inbMailRejected),
        ignored: num(inbMailIgnored), duplicate: num(inbMailDuplicate), error: num(inbMailError),
      },
      pending: null, failures24h: inbMailErr24,
      note: "Inbound mail log. 'error' rows failed validation/processing; retries go through inbound_jobs, not this table.",
    },
    {
      ref: null, source: "inbound_jobs", provider: "inbound-worker", endpoint: "/api/webhooks/email/inbound → /api/cron/inbound",
      lastEventAt: jobLast,
      counts: { queued: num(jobQueued), processing: num(jobProcessing), done: num(jobDone), failed: num(jobFailed), dead: num(jobDead) },
      pending: (jobQueued ?? 0) + (jobProcessing ?? 0), failures24h: jobFail24,
      note: "Durable job queue. Dead jobs can be requeued via replay (idempotent — worker dedupes on message_id).",
    },
    {
      ref: null, source: "sms_messages", provider: "twilio", endpoint: "/api/webhooks/twilio",
      lastEventAt: smsLast,
      counts: { inbound: num(smsInbound), outbound: num(smsOutbound) },
      pending: null, failures24h: smsFailed24,
      note: "Inbound SMS + Twilio delivery-status callbacks. 'failed/undelivered' counted for last 24h.",
    },
    {
      ref: null, source: "kiosk_events", provider: "kiosk_gateway", endpoint: "/api/devices/events",
      lastEventAt: kioLast,
      counts: { unprocessed: num(kioUnprocessed), processed: num(kioProcessed) },
      pending: kioUnprocessed, failures24h: kioRejected24,
      note: "Hardware ingest ledger. result='rejected:*' rows counted as failures for last 24h.",
    },
  ];
}

/* ── Inspector ─────────────────────────────────────────────────────────── */

/** Whitelisted columns per source — payloads and PII fields are never selected. */
const INSPECT_SELECT: Record<WebhookSourceId, { cols: string; map: (r: Record<string, unknown>) => Record<string, unknown> }> = {
  stripe_events: {
    cols: "id,type,received_at",
    map: (r) => ({ id: r.id, type: r.type, status: "recorded", receivedAt: r.received_at }),
  },
  inbound_emails: {
    cols: "id,message_id,status,reason,auth_method,dmarc_result,spf_result,dkim_result,processed_ms,created_at",
    // from_email/to_address/subject/body_preview are PII — deliberately not selected.
    map: (r) => ({
      id: r.id, messageId: r.message_id, status: r.status, reason: scrub(String(r.reason ?? ""), 200) || null,
      authMethod: r.auth_method, dmarc: r.dmarc_result, spf: r.spf_result, dkim: r.dkim_result,
      processedMs: r.processed_ms, createdAt: r.created_at,
    }),
  },
  inbound_jobs: {
    // payload is selected ONLY so relatedObject/payloadPreview can be derived
    // server-side — the raw payload is never returned to the client.
    cols: "id,kind,status,attempts,max_attempts,run_after,last_error,message_id,created_at,processed_at,payload",
    map: (r) => ({
      id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts,
      runAfter: r.run_after, lastError: scrub(String(r.last_error ?? ""), 300) || null,
      messageId: r.message_id, createdAt: r.created_at, processedAt: r.processed_at,
    }),
  },
  sms_messages: {
    cols: "id,direction,status,provider_sid,created_at",
    // from_number/to_number/body are PII — deliberately not selected.
    map: (r) => ({ id: r.id, direction: r.direction, status: r.status, providerSid: r.provider_sid, createdAt: r.created_at }),
  },
  kiosk_events: {
    cols: "id,event_id,kiosk_id,type,result,occurred_at,received_at,processed_at",
    // payload jsonb deliberately not selected.
    map: (r) => ({
      id: r.id, eventId: r.event_id, kioskId: r.kiosk_id, type: r.type, result: r.result,
      occurredAt: r.occurred_at, receivedAt: r.received_at, processedAt: r.processed_at,
    }),
  },
};

export type InspectResult =
  | { ok: true; event: Record<string, unknown> }
  | { ok: false; status: number; error: string };

export async function inspectWebhookEvent(db: SupabaseClient, source: WebhookSourceId, rowId: string): Promise<InspectResult> {
  const spec = INSPECT_SELECT[source];
  const { data, error } = await db.from(source).select(spec.cols).eq("id", rowId).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Event not found" };
  const row = data as unknown as Record<string, unknown>;
  const event: Record<string, unknown> = { source, sanitized: true, ...spec.map(row) };
  // Enrichment (Phase 4.4): verification status, derived business object,
  // sanitized payload preview (inbound_jobs only), retry eligibility.
  event.verification = signatureVerification(source, row);
  const related = relatedBusinessObject(source, row, source === "inbound_jobs" ? row.payload : undefined);
  if (related) event.relatedObject = related;
  if (source === "inbound_jobs") event.payloadPreview = inboundJobPayloadSummary(row.payload);
  event.replay = replayEligibility(source, row);
  return { ok: true, event };
}

/** Replay eligibility mirrored from replayWebhookEvent — keep in sync. */
export function replayEligibility(
  source: WebhookSourceId,
  row: Record<string, unknown>,
): { eligible: boolean; reason: string } {
  if (source === "stripe_events") {
    return { eligible: false, reason: "payment/financial event — replay forbidden (HTTP 403); re-send from the provider dashboard" };
  }
  if (source !== "inbound_jobs") {
    return { eligible: false, reason: `${source} rows cannot be replayed — no stored payload and/or non-idempotent handler` };
  }
  if (row.kind && row.kind !== "email_message") {
    return { eligible: false, reason: `job kind '${String(row.kind)}' is not replayable — only email_message jobs are` };
  }
  if (row.status !== "failed" && row.status !== "dead") {
    return { eligible: false, reason: `job status is '${String(row.status)}' — only failed/dead jobs can be replayed` };
  }
  return { eligible: true, reason: "requeue creates a NEW inbound_jobs attempt; the worker dedupes on message_id/content hash" };
}

/* ── Replay ────────────────────────────────────────────────────────────── */

export type ReplayResult =
  | { ok: true; status: "requeued"; jobId: string; replayOf: string; changeRequestId: string | null }
  | { ok: false; status: number; error: string; reason?: string };

/** Payment/financial sources are NEVER replayable — explicit 403, not 409. */
const FINANCIAL_SOURCES: readonly string[] = ["stripe_events"];
/** Only this inbound_jobs kind is replayable (whitelist, not blacklist). */
const REPLAYABLE_JOB_KIND = "email_message";
/** Max replay attempts spawned per original job — bounds replay storms. */
export const MAX_REPLAYS_PER_JOB = 5;

/**
 * Replays a webhook-sourced row by creating a NEW inbound_jobs attempt —
 * the original row is NEVER mutated (it stays failed/dead as the audit
 * trail of the first failure).
 *
 * Hard rules (Phase 4.4):
 *  - stripe_events (payment/financial) → 403 forbidden_financial. Financial
 *    events have no stored payload and fulfillment is not blindly re-runnable;
 *    re-send from the provider dashboard instead.
 *  - Every other non-inbound_jobs source → 409 replay_unsupported.
 *  - inbound_jobs: only kind='email_message' in failed/dead state.
 *  - The stored payload is NOT executed here — replay only re-enqueues. The
 *    /api/cron/inbound worker re-runs processInboundMail, which re-checks
 *    dmarc=fail quarantine, auto-submitted loop prevention, reply-token
 *    verification, and content-hash/message_id dedupe. A forged or stale
 *    payload therefore cannot bypass the real processor's checks.
 *  - Each replay inserts a new row with message_id `replay:<origId>:<n>`
 *    (the payload keeps the original Message-ID so processor-level dedupe
 *    still applies) and payload.replayedFrom/replayAttempt provenance.
 *  - Audited as webhook.replayed with actor + justification; breakglass and
 *    high/critical-risk callers still go through assertApprovedOrRequest.
 *  - Route-level rate limit: systemApiGuard(system.webhooks.retry, 20/min).
 */
export async function replayWebhookEvent(
  db: SupabaseClient,
  actor: SystemActor,
  source: WebhookSourceId,
  rowId: string,
  justification?: string,
): Promise<ReplayResult> {
  if (FINANCIAL_SOURCES.includes(source)) {
    await systemAudit(db, {
      actor, action: "webhook.replay_denied", resource: `webhook:${source}:${rowId}`,
      detail: { source, reason: "financial/payment event — replay forbidden" },
    });
    return { ok: false, status: 403, error: "forbidden_financial", reason: "Payment/financial webhook events are never replayable — they have no stored payload and fulfillment is not idempotent. Re-send the event from the Stripe dashboard if needed." };
  }
  if (source !== "inbound_jobs") {
    await systemAudit(db, {
      actor, action: "webhook.replay_unsupported", resource: `webhook:${source}:${rowId}`,
      detail: { source, reason: "no safe replay path — payload not stored / handler not idempotent" },
    });
    return { ok: false, status: 409, error: "replay_unsupported", reason: `${source} rows cannot be replayed: no stored payload and/or non-idempotent handler. Use the provider dashboard to re-send the event.` };
  }

  const { data: job, error } = await db
    .from("inbound_jobs")
    .select("id,kind,status,attempts,max_attempts,payload")
    .eq("id", rowId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!job) return { ok: false, status: 404, error: "Job not found" };
  const j = job as { id: string; kind: string | null; status: string; attempts: number; max_attempts: number | null; payload: unknown };
  if (j.kind && j.kind !== REPLAYABLE_JOB_KIND) {
    return { ok: false, status: 409, error: "kind_not_replayable", reason: `Job kind '${j.kind}' is not replayable — only ${REPLAYABLE_JOB_KIND} jobs are whitelisted.` };
  }
  if (j.status !== "failed" && j.status !== "dead") {
    return { ok: false, status: 409, error: "not_replayable", reason: `Job status is "${j.status}" — only failed/dead jobs can be replayed.` };
  }
  if (!j.payload || typeof j.payload !== "object" || Array.isArray(j.payload)) {
    return { ok: false, status: 409, error: "no_payload", reason: "Job has no stored payload to re-enqueue." };
  }

  const action = `webhook.replay:inbound_jobs:${j.id}`;
  const approval = await assertApprovedOrRequest(db, actor, {
    action,
    risk: "medium",
    justification: justification ?? `Replay inbound email job ${j.id} (status ${j.status}, ${j.attempts} attempts) as a NEW queue attempt — worker dedupes on message_id/content hash.`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "webhook.replay_pending", resource: `inbound_jobs:${j.id}`, detail: { changeRequestId: approval.changeRequestId } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — replay executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  // Count prior replay children (message_id `replay:<origId>:<n>`) and cap.
  const prefix = `replay:${j.id}:`;
  const { data: prior, error: countErr } = await db
    .from("inbound_jobs")
    .select("id")
    .like("message_id", `${prefix}%`)
    .limit(MAX_REPLAYS_PER_JOB + 1);
  if (countErr) return { ok: false, status: 500, error: countErr.message };
  const existing = (prior ?? []).length;
  if (existing >= MAX_REPLAYS_PER_JOB) {
    await systemAudit(db, {
      actor, action: "webhook.replay_denied", resource: `inbound_jobs:${j.id}`,
      detail: { reason: "replay_limit", attempts: existing },
    });
    return { ok: false, status: 409, error: "replay_limit", reason: `Job already has ${existing} replay attempts (max ${MAX_REPLAYS_PER_JOB}). Investigate the root cause instead of replaying again.` };
  }

  // Insert the NEW attempt row. The unique message_id suffix makes concurrent
  // replays collide safely — on 23505 we bump the suffix and retry once.
  const payload = {
    ...(j.payload as Record<string, unknown>),
    replayedFrom: j.id,
    replayAttempt: existing + 1,
  };
  let newJobId: string | null = null;
  let lastErr = "insert failed";
  for (let n = existing + 1; n <= existing + 2 && !newJobId; n++) {
    const { data: inserted, error: insErr } = await db
      .from("inbound_jobs")
      .insert({
        kind: REPLAYABLE_JOB_KIND,
        payload,
        status: "queued",
        attempts: 0,
        max_attempts: j.max_attempts ?? 5,
        run_after: new Date().toISOString(),
        message_id: `${prefix}${n}`,
        dedupe_hash: null,
      })
      .select("id")
      .single();
    if (!insErr && inserted?.id) {
      newJobId = (inserted as { id: string }).id;
      break;
    }
    lastErr = insErr?.message ?? "insert failed";
    if (insErr?.code !== "23505") break; // only unique-collision is retryable
  }
  if (!newJobId) return { ok: false, status: 500, error: lastErr };

  await systemAudit(db, {
    actor, action: "webhook.replayed", resource: `inbound_jobs:${newJobId}`,
    detail: {
      replayOf: j.id, replayAttempt: existing + 1, newJobId,
      previousStatus: j.status, previousAttempts: j.attempts,
      justification: justification?.slice(0, 500) ?? null,
      changeRequestId: approval.changeRequestId,
    },
  });
  return { ok: true, status: "requeued", jobId: newJobId, replayOf: j.id, changeRequestId: approval.changeRequestId };
}
