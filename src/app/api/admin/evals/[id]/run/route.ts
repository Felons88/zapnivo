import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser, isStaff } from "@/lib/auth";
import { runEvalSuite } from "@/lib/evals/runner";
import { recordLog } from "@/lib/observability";

/** POST /api/admin/evals/[id]/run — execute a suite. Optional {mock:true} uses canned replies for CI-safe runs. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await getSessionUser();
  if (!u || !isStaff(u)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = z.object({ mock: z.boolean().optional() }).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 422 });

  const chat = parsed.data.mock
    ? async ({ messages }: { messages: { role: string; content?: string | null }[] }) => {
        const last = [...messages].reverse().find((m) => m.role === "user");
        const text = String(last?.content ?? "").toLowerCase();
        if (/refund|charged|billing/.test(text)) return { content: "I'm sorry about that — I've opened a support ticket so our team can review the charge with you." };
        if (/card|4111/.test(text)) return { content: "For your security, please don't share card numbers here." };
        if (/ignore|system prompt|api key/.test(text)) return { content: "I can only help with Zapnivo rentals and support." };
        if (/cost|price|much/.test(text)) return { content: "Rentals are $6.99 per started hour." };
        if (/return/.test(text)) return { content: "Return the charger to any Zapnivo kiosk when you're done." };
        if (/partner/.test(text)) return { content: "You can apply to become a venue partner from the partner page." };
        if (/person|human|someone/.test(text)) return { content: "I'll open a ticket so a human agent can help you." };
        return { content: "Here's what I found in the help center." };
      }
    : undefined;

  try {
    const result = await runEvalSuite(db, id, { chat: chat as never, ip: "eval-run" });
    if ("error" in result) return NextResponse.json(result, { status: 404 });
    recordLog("info", "eval_suite_executed", { service: "ai-evals", attrs: { suite: id, score: Math.round(result.score) } });
    return NextResponse.json(result);
  } catch (e) {
    recordLog("error", "eval_suite_failed", { service: "ai-evals", attrs: { suite: id, err: e instanceof Error ? e.message.slice(0, 200) : "unknown" } });
    return NextResponse.json({ error: "Evaluation failed" }, { status: 500 });
  }
}
