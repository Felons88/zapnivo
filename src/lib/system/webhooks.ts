import type { SupabaseClient } from "@supabase/supabase-js";
import { scrub } from "@/lib/observability";
import { assertApprovedOrRequest, systemAudit, type SystemActor } from "./audit";

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
    cols: "id,kind,status,attempts,max_attempts,run_after,last_error,message_id,created_at,processed_at",
    // payload jsonb is deliberately not selected (may contain email bodies/PII).
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
  return { ok: true, event: { source, sanitized: true, ...spec.map(data as unknown as Record<string, unknown>) } };
}

/* ── Replay ────────────────────────────────────────────────────────────── */

export type ReplayResult =
  | { ok: true; status: "requeued"; jobId: string; changeRequestId: string | null }
  | { ok: false; status: number; error: string; reason?: string };

/**
 * Replays a webhook-sourced row. ONLY inbound_jobs failed/dead rows are
 * replayable — the worker claims them with a conditional update and dedupes on
 * message_id/dedupe_hash, so requeueing cannot double-process. Everything else
 * (stripe_events, inbound_emails, sms_messages, kiosk_events) has no safe
 * server-side replay path → 409 replay_unsupported.
 */
export async function replayWebhookEvent(
  db: SupabaseClient,
  actor: SystemActor,
  source: WebhookSourceId,
  rowId: string,
  justification?: string,
): Promise<ReplayResult> {
  if (source !== "inbound_jobs") {
    await systemAudit(db, {
      actor, action: "webhook.replay_unsupported", resource: `webhook:${source}:${rowId}`,
      detail: { source, reason: "no safe replay path — payload not stored / handler not idempotent" },
    });
    return { ok: false, status: 409, error: "replay_unsupported", reason: `${source} rows cannot be replayed: no stored payload and/or non-idempotent handler. Use the provider dashboard to re-send the event.` };
  }

  const { data: job, error } = await db
    .from("inbound_jobs")
    .select("id,status,attempts")
    .eq("id", rowId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!job) return { ok: false, status: 404, error: "Job not found" };
  const j = job as { id: string; status: string; attempts: number };
  if (j.status !== "failed" && j.status !== "dead") {
    return { ok: false, status: 409, error: "not_replayable", reason: `Job status is "${j.status}" — only failed/dead jobs can be requeued.` };
  }

  const action = `webhook.replay:inbound_jobs:${j.id}`;
  const approval = await assertApprovedOrRequest(db, actor, {
    action,
    risk: "medium",
    justification: justification ?? `Requeue inbound email job ${j.id} (status ${j.status}, ${j.attempts} attempts) — worker dedupes on message_id.`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "webhook.replay_pending", resource: `inbound_jobs:${j.id}`, detail: { changeRequestId: approval.changeRequestId } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — replay executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const { data: updated, error: upErr } = await db
    .from("inbound_jobs")
    .update({ status: "queued", attempts: 0, run_after: new Date().toISOString(), last_error: null, processed_at: null })
    .eq("id", j.id)
    .eq("status", j.status) // optimistic guard: only requeue if still in the same state
    .select("id")
    .maybeSingle();
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  if (!updated) return { ok: false, status: 409, error: "state_changed", reason: "Job status changed concurrently — refresh and retry." };

  await systemAudit(db, {
    actor, action: "webhook.replayed", resource: `inbound_jobs:${j.id}`,
    detail: { previousStatus: j.status, attempts: j.attempts, changeRequestId: approval.changeRequestId },
  });
  return { ok: true, status: "requeued", jobId: j.id, changeRequestId: approval.changeRequestId };
}
