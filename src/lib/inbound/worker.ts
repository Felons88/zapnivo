import { defaultCtx, type Ctx } from "../helpdesk/service";
import { serviceClient } from "../supabase";
import { processInboundMail, type Parsed } from "./processor";
import { reportError } from "../observability";

/**
 * Durable inbound-email worker (Stage B). Claims queued jobs with a
 * conditional status transition so concurrent workers can't double-claim,
 * processes each through the ticket pipeline, retries with exponential
 * backoff, dead-letters after max_attempts, and recovers jobs stuck in
 * 'processing' (worker killed mid-flight). Safe to invoke from Vercel cron
 * and from the webhook's post-response kick — claims are atomic.
 */

const BATCH = 20;
const STUCK_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 30_000;

type Db = NonNullable<ReturnType<typeof serviceClient>>;
type Job = { id: string; payload: Parsed; attempts: number; max_attempts: number };

async function recoverStuck(db: Db) {
  await db.from("inbound_jobs")
    .update({ status: "queued", claimed_at: null })
    .eq("status", "processing")
    .lt("claimed_at", new Date(Date.now() - STUCK_MS).toISOString());
}

const claim = async (db: Db, j: Job) => {
  const { data } = await db.from("inbound_jobs")
    .update({ status: "processing", attempts: j.attempts + 1, claimed_at: new Date().toISOString() })
    .eq("id", j.id).eq("status", "queued")
    .select("id");
  return (data?.length ?? 0) > 0;
};

const finishJob = (db: Db, id: string, patch: Record<string, unknown>) =>
  db.from("inbound_jobs").update({ ...patch, processed_at: new Date().toISOString() }).eq("id", id);

/** Processes up to `limit` due jobs. Returns per-status counts. */
export async function runInboundWorker(limit = BATCH): Promise<{ claimed: number; done: number; retried: number; dead: number; errors: string[] }> {
  const db = serviceClient();
  const out = { claimed: 0, done: 0, retried: 0, dead: 0, errors: [] as string[] };
  if (!db) return out;
  await recoverStuck(db);

  // Helpdesk ctx is only needed for ticket-bound mail; receptionist (hello@)
  // jobs still process when the helpdesk context is unavailable.
  const ctx: Ctx | null = await defaultCtx().catch(() => null);

  const { data: due } = await db.from("inbound_jobs")
    .select("id,payload,attempts,max_attempts")
    .eq("status", "queued")
    .lte("run_after", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);

  for (const j of (due ?? []) as Job[]) {
    if (!(await claim(db, j))) continue;
    out.claimed++;
    try {
      const outcome = await processInboundMail(ctx, db, j.payload);
      await finishJob(db, j.id, { status: "done", last_error: outcome.status === "error" ? outcome.reason : null });
      out.done++;
    } catch (e) {
      const attempts = j.attempts + 1;
      const msg = e instanceof Error ? e.message.slice(0, 300) : "unknown";
      if (attempts >= j.max_attempts) {
        await finishJob(db, j.id, { status: "dead", last_error: msg });
        reportError(e, { route: "inbound/worker", severity: "critical", attrs: { jobId: j.id, attempts } });
        out.dead++;
      } else {
        const backoff = BASE_BACKOFF_MS * 2 ** attempts;
        await db.from("inbound_jobs").update({
          status: "queued", claimed_at: null, last_error: msg,
          run_after: new Date(Date.now() + backoff).toISOString(),
        }).eq("id", j.id);
        out.retried++;
      }
      out.errors.push(msg);
    }
  }
  return out;
}

/** Queue-depth snapshot for admin monitoring. */
export async function inboundQueueStats() {
  const db = serviceClient();
  if (!db) return null;
  const { data } = await db.from("inbound_jobs")
    .select("status")
    .in("status", ["queued", "processing", "dead"]);
  const rows = (data ?? []) as { status: string }[];
  return {
    queued: rows.filter((r) => r.status === "queued").length,
    processing: rows.filter((r) => r.status === "processing").length,
    dead: rows.filter((r) => r.status === "dead").length,
  };
}
