import { beforeEach, describe, expect, it, vi } from "vitest";

const { ctxHolder, dbHolder, procHolder } = vi.hoisted(() => ({
  ctxHolder: { ctx: null as unknown },
  dbHolder: { db: null as unknown },
  procHolder: { fn: null as unknown },
}));

vi.mock("@/lib/helpdesk/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/helpdesk/service")>();
  return { ...mod, defaultCtx: async () => ctxHolder.ctx };
});
vi.mock("@/lib/supabase", () => ({ serviceClient: () => dbHolder.db }));
vi.mock("@/lib/inbound/processor", () => ({
  processInboundMail: (...args: unknown[]) => (procHolder.fn as (...a: unknown[]) => unknown)(...args),
}));

import { POST } from "@/app/api/webhooks/email/inbound/route";
import { runInboundWorker } from "@/lib/inbound/worker";
import { MemoryRepo } from "@/lib/helpdesk/memory-repo";
import { DemoRentalDirectory } from "@/lib/helpdesk/rentals";
import * as svc from "@/lib/helpdesk/service";
import { NotConfiguredRefundProvider } from "@/lib/payments/source";

const NOW = new Date("2026-11-10T12:00:00Z");
const mkCtx = (repo = new MemoryRepo()): svc.Ctx => ({
  repo, chat: null, mailer: null, rentals: new DemoRentalDirectory(),
  refunds: new NotConfiguredRefundProvider(), now: () => NOW, siteUrl: "https://z.test",
});

/** Minimal thenable stand-in for the supabase-js query builder (inbound_jobs only). */
function fakeJobsDb(rows: Record<string, unknown>[]) {
  const table = () => {
    const state: { filters: ((r: Record<string, unknown>) => boolean)[]; op: "select" | "update"; patch: Record<string, unknown>; returning: boolean } = {
      filters: [], op: "select", patch: {}, returning: false,
    };
    const matched = () => rows.filter((r) => state.filters.every((f) => f(r)));
    const api: Record<string, unknown> = {};
    const self = () => api;
    api.select = () => { if (state.op === "update") state.returning = true; return self(); };
    api.insert = async (row: Record<string, unknown>) => {
      if (rows.some((r) => row.message_id && r.message_id === row.message_id)) return { data: null, error: { code: "23505" } };
      rows.push({ id: `j${rows.length + 1}`, status: "queued", attempts: 0, max_attempts: 5, run_after: new Date().toISOString(), created_at: new Date().toISOString(), ...row });
      return { data: null, error: null };
    };
    api.update = (patch: Record<string, unknown>) => { state.op = "update"; state.patch = patch; return self(); };
    api.eq = (k: string, v: unknown) => { state.filters.push((r) => r[k] === v); return self(); };
    api.neq = (k: string, v: unknown) => { state.filters.push((r) => r[k] !== v); return self(); };
    api.in = (k: string, vals: unknown[]) => { state.filters.push((r) => vals.includes(r[k])); return self(); };
    api.lte = (k: string, v: string) => { state.filters.push((r) => String(r[k] ?? "") <= v); return self(); };
    api.lt = (k: string, v: string) => { state.filters.push((r) => String(r[k] ?? "") < v); return self(); };
    api.gte = (k: string, v: string) => { state.filters.push((r) => String(r[k] ?? "") >= v); return self(); };
    api.order = () => self();
    api.limit = () => self(); // tests use few rows; limit is a no-op
    api.single = async () => ({ data: matched()[0] ?? null, error: null });
    api.maybeSingle = api.single;
    api.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const m = matched();
      let data: unknown;
      if (state.op === "update") {
        for (const r of m) Object.assign(r, state.patch);
        data = state.returning ? m.map((r) => ({ id: r.id })) : m;
      } else {
        data = m.map((r) => ({ ...r })); // snapshot, like a real select
      }
      return Promise.resolve({ data, error: null }).then(res, rej);
    };
    return api;
  };
  return { jobs: rows, from: (t: string) => (t === "inbound_jobs" ? table() : table()) };
}

const SECRET = "test-inbound-secret";
const post = (payload: unknown) => POST(new Request(`http://localhost/api/webhooks/email/inbound?key=${SECRET}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
}));

const brevo = (over: Record<string, unknown> = {}) => ({
  MessageId: "<job-1@x>", From: { Address: "a@b.com" }, To: [{ Address: "support@in.zapnivo.com" }],
  Subject: "hi", RawTextBody: "hello there", Headers: {}, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EMAIL_INBOUND_SECRET = SECRET;
  ctxHolder.ctx = mkCtx();
  procHolder.fn = vi.fn(async () => ({ status: "accepted", reason: null, ticket: "Z-1" }));
});

describe("Stage A — durable ingestion", () => {
  it("persists each message to inbound_jobs and acks without processing", async () => {
    const jobs: Record<string, unknown>[] = [];
    dbHolder.db = fakeJobsDb(jobs);
    const res = await post({ items: [brevo(), brevo({ MessageId: "<job-2@x>" })] });
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, queued: 2, duplicates: 0 });
    expect(jobs).toHaveLength(2);
    expect(jobs[0].payload).toMatchObject({ from: "a@b.com" });
    expect(procHolder.fn).not.toHaveBeenCalled(); // nothing processed inline
  });

  it("treats a repeated MessageId as a duplicate at enqueue", async () => {
    const jobs: Record<string, unknown>[] = [];
    dbHolder.db = fakeJobsDb(jobs);
    await post({ items: [brevo()] });
    const res = await post({ items: [brevo()] });
    expect(await res.json()).toMatchObject({ queued: 0, duplicates: 1 });
    expect(jobs).toHaveLength(1);
  });
});

describe("Stage B — durable worker", () => {
  const seed = (over: Record<string, unknown> = {}) => ({
    id: "j1", status: "queued", attempts: 0, max_attempts: 3,
    run_after: new Date(Date.now() - 1000).toISOString(),
    payload: { from: "a@b.com", subject: "s", text: "t", messageId: "<x>", recipients: [], dmarc: null, spf: null, dkim: null, inReplyTo: null },
    ...over,
  });

  it("claims and completes a queued job", async () => {
    const jobs = [seed()];
    dbHolder.db = fakeJobsDb(jobs);
    const r = await runInboundWorker(10);
    expect(r).toMatchObject({ claimed: 1, done: 1 });
    expect(procHolder.fn).toHaveBeenCalledTimes(1);
    expect(jobs[0].status).toBe("done");
  });

  it("retries with backoff on processor failure, dead-letters at max attempts", async () => {
    procHolder.fn = vi.fn(async () => { throw new Error("boom"); });
    const jobs = [seed({ attempts: 0, max_attempts: 2 })];
    dbHolder.db = fakeJobsDb(jobs);
    let r = await runInboundWorker(10);
    expect(r).toMatchObject({ claimed: 1, retried: 1 });
    expect(jobs[0].status).toBe("queued");
    expect(String(jobs[0].run_after)).not.toBe("");
    jobs[0].run_after = new Date(Date.now() - 1000).toISOString(); // make due again
    jobs[0].attempts = 1;
    r = await runInboundWorker(10);
    expect(r).toMatchObject({ claimed: 1, dead: 1 });
    expect(jobs[0].status).toBe("dead");
  });

  it("does not claim jobs that aren't due yet", async () => {
    const jobs = [seed({ run_after: new Date(Date.now() + 60_000).toISOString() })];
    dbHolder.db = fakeJobsDb(jobs);
    const r = await runInboundWorker(10);
    expect(r.claimed).toBe(0);
    expect(procHolder.fn).not.toHaveBeenCalled();
  });

  it("recovers jobs stuck in processing", async () => {
    const jobs = [seed({ status: "processing", claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() })];
    dbHolder.db = fakeJobsDb(jobs);
    await runInboundWorker(10);
    expect(jobs[0].status).toBe("done"); // recovered → claimed → processed
    expect(procHolder.fn).toHaveBeenCalledTimes(1);
  });
});
