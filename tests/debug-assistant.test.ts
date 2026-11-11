import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

const { session, serviceClientMock, chatMock } = vi.hoisted(() => ({
  session: vi.fn(),
  serviceClientMock: vi.fn(),
  chatMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: session,
  isStaff: (u: { role?: string } | null) => u?.role === "admin" || u?.role === "staff",
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: serviceClientMock, anonClient: () => null, backendConfigured: () => true }));
vi.mock("@/lib/ai/openrouter", () => ({
  openrouterChat: chatMock,
  assistantConfigured: () => true,
  AssistantUnavailable: class AssistantUnavailable extends Error {},
}));

import { analyzeIssue, ensureDebuggerAgent, DEBUGGER_AGENT_ID, parseAnalysis } from "@/lib/debug/assistant";
import { POST } from "@/app/api/admin/observability/issues/[id]/analyze/route";
import { resetRateLimits } from "@/lib/rate-limit";

type Row = Record<string, unknown>;

/** Generic in-memory Supabase fake covering the query shapes used by assistant.ts, registry.ts and recordLog. */
function makeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    error_issues: [],
    error_events: [],
    app_logs: [],
    ai_agents: [],
    ai_agent_runs: [],
    ...seed,
  };
  let runSeq = 1;

  class Q {
    private filters: ((r: Row) => boolean)[] = [];
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: Row | Row[] | null = null;
    private ignoreDup = false;
    private ord: string | null = null;
    private ordAsc = true;
    private lim: number | null = null;
    private mode: "single" | "maybe" | null = null;

    constructor(private rows: Row[]) {}
    select() { return this; }
    insert(row: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(row) ? row : [row]; return this; }
    upsert(rows: Row[], opts?: { ignoreDuplicates?: boolean }) { this.op = "upsert"; this.payload = rows; this.ignoreDup = !!opts?.ignoreDuplicates; return this; }
    update(obj: Row) { this.op = "update"; this.payload = obj; return this; }
    eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
    gte(col: string, val: unknown) { this.filters.push((r) => typeof r[col] === "string" && String(r[col]) >= String(val)); return this; }
    order(col: string, opts?: { ascending?: boolean }) { this.ord = col; this.ordAsc = opts?.ascending !== false; return this; }
    limit(n: number) { this.lim = n; return this; }
    single() { this.mode = "single"; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }

    private match(r: Row) { return this.filters.every((f) => f(r)); }

    private exec(): { data: unknown; error: unknown } {
      if (this.op === "insert") {
        const rows = (this.payload as Row[]).map((r) => {
          const row = { ...r };
          if (this.rows === tables.ai_agent_runs && row.id == null) row.id = runSeq++;
          this.rows.push(row);
          return row;
        });
        const data = this.mode ? rows[0] ?? null : rows;
        const error = this.mode === "single" && !rows.length ? { message: "no rows" } : null;
        return { data, error };
      }
      if (this.op === "upsert") {
        for (const r of this.payload as Row[]) {
          const ex = this.rows.find((x) => x.id === r.id);
          if (ex) { if (!this.ignoreDup) Object.assign(ex, r); }
          else this.rows.push({ ...r });
        }
        return { data: this.rows.filter((r) => this.match(r)), error: null };
      }
      if (this.op === "update") {
        const affected = this.rows.filter((r) => this.match(r));
        for (const r of affected) Object.assign(r, this.payload as Row);
        const data = this.mode ? affected[0] ?? null : affected;
        return { data, error: null };
      }
      let out = this.rows.filter((r) => this.match(r));
      if (this.ord) {
        out = [...out].sort((a, b) => {
          const av = String(a[this.ord!] ?? "");
          const bv = String(b[this.ord!] ?? "");
          return this.ordAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      const data = this.mode ? out[0] ?? null : out;
      const error = this.mode === "single" && !out.length ? { message: "no rows" } : null;
      return { data, error };
    }

    then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
      onF?: ((v: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onR?: ((e: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(this.exec()).then(onF, onR);
    }
  }

  return {
    from: (table: string) => new Q(tables[table] ?? (tables[table] = [])),
    _tables: tables,
  };
}

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISSUE: Row = {
  id: ISSUE_ID,
  fingerprint: "fpdeadbeefcafe1234567890ab",
  title: "TypeError: Cannot read properties of undefined",
  culprit: "/api/rentals/start",
  status: "new",
  severity: "error",
  first_seen: "2025-01-01T00:00:00Z",
  last_seen: "2025-01-02T00:00:00Z",
  event_count: 7,
};

function seedDb(extra: Record<string, Row[]> = {}) {
  return makeDb({
    error_issues: [{ ...ISSUE }],
    error_events: [
      {
        fingerprint: "fpdeadbeefcafe1234567890ab",
        title: "TypeError: Cannot read properties of undefined (reading 'id')",
        message: "contact victim@example.com otp=998877 about the failure",
        stack: "TypeError: boom\n    at handler (src/app/api/rentals/start/route.ts:42:9)\n    at node_modules/x/y.js:1:1",
        route: "/api/rentals/start",
        runtime: "server",
        severity: "error",
        release: "abc123def456",
        environment: "production",
        occurred_at: new Date().toISOString(),
      },
    ],
    app_logs: [
      { ts: new Date().toISOString(), level: "error", service: "web", message: "rental start failed for user bob@example.com", route: "/api/rentals/start" },
    ],
    ...extra,
  });
}

const AGENT_ROW: Row = {
  id: DEBUGGER_AGENT_ID,
  name: "Observability Debugger",
  description: "seeded",
  department: "operations",
  model: "openai/gpt-4o-mini",
  temperature: 0.2,
  max_tokens: 700,
  timeout_ms: 25000,
  permissions: ["observability.read"],
  tools: [],
  enabled: true,
  daily_budget_cents: 0,
  monthly_budget_cents: 0,
  max_calls_per_hour: 60,
  escalation_policy: "staff_review",
  config: {},
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

const MODEL_JSON = JSON.stringify({
  summary: "Rental start crashes when the kiosk lookup returns null.",
  likelyCauses: ["Missing null check on kiosk lookup", "Race between kiosk heartbeat and start"],
  correlatedSignals: ["Error spike began after release abc123def456"],
  suggestedTests: ["Unit test start handler with null lookup", "Integration test concurrent heartbeat+start"],
  draftIssue: { title: "TypeError on POST /api/rentals/start", body: "## Summary\nCrash on null lookup.\n\nFingerprint: fpdeadbeefcafe1234567890ab" },
  confidence: "medium",
});

beforeEach(() => {
  vi.resetAllMocks();
  resetRateLimits();
  session.mockResolvedValue({ id: "staff-1", email: "staff@zapnivo.com", role: "staff", organizationId: null });
  serviceClientMock.mockReturnValue(null);
  chatMock.mockResolvedValue({ content: MODEL_JSON });
});

describe("analyzeIssue", () => {
  it("returns a structured analysis and sends a scrubbed prompt", async () => {
    const db = seedDb() as unknown as SupabaseClient;
    const chat = vi.fn().mockResolvedValue({ content: MODEL_JSON });
    const out = await analyzeIssue(db, ISSUE_ID, { chat });

    expect(out.summary).toContain("kiosk lookup");
    expect(out.likelyCauses).toHaveLength(2);
    expect(out.suggestedTests).toHaveLength(2);
    expect(out.draftIssue.title).toBe("TypeError on POST /api/rentals/start");
    expect(out.draftIssue.body).toContain("fpdeadbeefcafe1234567890ab");
    expect(out.confidence).toBe("medium");

    expect(chat).toHaveBeenCalledTimes(1);
    const messages = chat.mock.calls[0][0].messages;
    const all = messages.map((m: { content: string }) => m.content).join("\n");
    // PII / secrets injected into telemetry must be scrubbed before reaching the model.
    expect(all).not.toContain("victim@example.com");
    expect(all).not.toContain("bob@example.com");
    expect(all).not.toContain("998877");
    expect(all).toContain("[email]");
    expect(all).toContain("read-only; propose only");
    // Stack is reduced to the first app frame.
    expect(all).toContain("src/app/api/rentals/start/route.ts:42:9");
    expect(all).not.toContain("node_modules/x/y.js");
  });

  it("throws issue_not_found for unknown ids", async () => {
    const db = makeDb({ error_issues: [] }) as unknown as SupabaseClient;
    await expect(analyzeIssue(db, ISSUE_ID, { chat: chatMock })).rejects.toThrow("issue_not_found");
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("degrades gracefully on unparseable model output", async () => {
    const db = seedDb() as unknown as SupabaseClient;
    const chat = vi.fn().mockResolvedValue({ content: "sorry, I cannot help with that" });
    const out = await analyzeIssue(db, ISSUE_ID, { chat });
    expect(out.summary).toContain("cannot help");
    expect(out.confidence).toBe("low");
    expect(out.draftIssue).toEqual({ title: "", body: "" });
  });
});

describe("parseAnalysis", () => {
  it("extracts JSON from a fenced block", () => {
    const out = parseAnalysis("Here you go:\n```json\n" + MODEL_JSON + "\n```\nDone.");
    expect(out.confidence).toBe("medium");
    expect(out.likelyCauses[0]).toContain("null check");
  });
});

describe("POST /api/admin/observability/issues/[id]/analyze", () => {
  const post = (id: string) =>
    new Request(`http://localhost/api/admin/observability/issues/${id}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }) as unknown as NextRequest;
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("rejects non-staff callers before touching the DB or the model", async () => {
    session.mockResolvedValue({ id: "cust-1", email: "c@example.com", role: "customer", organizationId: null });
    const res = await POST(post(ISSUE_ID), params(ISSUE_ID));
    expect(res.status).toBe(403);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("rejects invalid issue ids", async () => {
    serviceClientMock.mockReturnValue(seedDb());
    const res = await POST(post("not-a-uuid"), params("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("runs the analysis for staff and records an ai_agent_runs row", async () => {
    const db = seedDb({ ai_agents: [{ ...AGENT_ROW }] });
    serviceClientMock.mockReturnValue(db);
    const res = await POST(post(ISSUE_ID), params(ISSUE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.analysis.draftIssue.title).toContain("TypeError");
    expect(body.runId).toBeTruthy();

    const runs = (db as unknown as { _tables: Record<string, Row[]> })._tables.ai_agent_runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].agent_id).toBe(DEBUGGER_AGENT_ID);
    expect(runs[0].task).toBe(`issue-analysis:${ISSUE_ID}`);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].actor).toBe("staff-1");

    // The prompt sent to the model was scrubbed.
    const messages = chatMock.mock.calls[0][0].messages;
    const all = messages.map((m: { content: string }) => m.content).join("\n");
    expect(all).not.toContain("victim@example.com");
    expect(all).not.toContain("998877");
  });

  it("returns 404 when the issue does not exist and records an error run", async () => {
    const db = seedDb({ error_issues: [], ai_agents: [{ ...AGENT_ROW }] });
    serviceClientMock.mockReturnValue(db);
    const res = await POST(post(ISSUE_ID), params(ISSUE_ID));
    expect(res.status).toBe(404);
    const runs = (db as unknown as { _tables: Record<string, Row[]> })._tables.ai_agent_runs;
    expect(runs.some((r) => r.status === "error")).toBe(true);
  });

  it("returns 503 when the backend is not configured", async () => {
    serviceClientMock.mockReturnValue(null);
    const res = await POST(post(ISSUE_ID), params(ISSUE_ID));
    expect(res.status).toBe(503);
  });
});

describe("ensureDebuggerAgent", () => {
  it("upserts the ops.debugger row idempotently", async () => {
    const db = makeDb() as unknown as SupabaseClient;
    await ensureDebuggerAgent(db);
    await ensureDebuggerAgent(db);
    const agents = (db as unknown as { _tables: Record<string, Row[]> })._tables.ai_agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("ops.debugger");
    expect(agents[0].enabled).toBe(true);
  });
});
