import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import { rateLimit } from "@/lib/rate-limit";
import { runAgent } from "@/lib/agents/registry";
import { openrouterChat } from "@/lib/ai/openrouter";
import { recordLog } from "@/lib/observability";
import {
  analyzeIssue,
  ensureDebuggerAgent,
  ANALYZE_ROUTE,
  DEBUGGER_AGENT_ID,
  DEBUGGER_TASK,
} from "@/lib/debug/assistant";

const idSchema = z.string().uuid();
const bodySchema = z.object({}).strict(); // POST takes no fields; body is optional

/**
 * Staff-only "Analyze with AI" for an error_issue. Read-only analysis: the only
 * DB writes are the ops.debugger agent seed row and the ai_agent_runs record
 * written by runAgent (running → ok/error). Rate-limited per staff user.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  if (!idSchema.safeParse(id).success) return NextResponse.json({ error: "Invalid issue id" }, { status: 400 });

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const rl = rateLimit(`ai-debug:${user.id}`, 10, 3_600_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limited — try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const body = await req.json().catch(() => ({}));
  if (!bodySchema.safeParse(body ?? {}).success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 422 });
  }

  await ensureDebuggerAgent(db);
  const outcome = await runAgent(db, DEBUGGER_AGENT_ID, {
    task: `${DEBUGGER_TASK}:${id}`,
    actor: user.id,
    execute: () => analyzeIssue(db, id, { chat: openrouterChat }),
  });

  if (!outcome.ok) {
    const status = outcome.status === "denied" ? 409 : outcome.error === "issue_not_found" ? 404 : 502;
    recordLog("warning", `AI issue analysis failed for ${id}: ${outcome.error ?? outcome.reason ?? outcome.status}`, {
      service: "ai-debug",
      route: ANALYZE_ROUTE,
      attrs: { issue: id, status: outcome.status, runId: outcome.runId, actor: user.id },
    });
    return NextResponse.json({ error: outcome.error ?? outcome.reason ?? "analysis_failed" }, { status });
  }

  recordLog("info", `AI issue analysis served for ${id}`, {
    service: "ai-debug",
    route: ANALYZE_ROUTE,
    attrs: { issue: id, runId: outcome.runId, actor: user.id },
  });
  return NextResponse.json({ ok: true, analysis: outcome.result, runId: outcome.runId });
}
