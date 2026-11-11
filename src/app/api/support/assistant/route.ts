import { NextResponse } from "next/server";
import { z } from "zod";
import { CARD_WARNING, containsCardNumber, runAssistant } from "@/lib/ai/assistant";
import { assistantConfigured } from "@/lib/ai/openrouter";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(1000) })).min(1).max(12),
});

/** Session lookup is best-effort: a broken session check must never take the public assistant down. */
async function sessionActor() {
  try { return await getSessionUser(); } catch { return null; }
}
const authInfo = (actor: Awaited<ReturnType<typeof sessionActor>>) => ({ verified: !!actor, email: actor?.email ?? null, role: actor?.role ?? null });

/**
 * AI support assistant. Server-side only: key stays private, input is capped, card-like text is
 * blocked BEFORE it reaches the model, and rental lookups go through the same guarded service
 * as the public lookup form.
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

  const rl = rateLimit(`assistant:${ip}`, 20, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "You're sending messages quickly. Please wait a moment and try again." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || parsed.data.messages.at(-1)!.role !== "user") return NextResponse.json({ error: "Invalid request." }, { status: 422 });
  const { messages } = parsed.data;

  if (containsCardNumber(messages)) {
    const actor = await sessionActor();
    return NextResponse.json({ reply: CARD_WARNING, rentals: [], sources: [], auth: authInfo(actor) });
  }

  const actor = await sessionActor();
  if (!assistantConfigured()) {
    return NextResponse.json({ error: "The AI assistant isn't available yet. Search the help center or open a ticket and we'll help.", code: "assistant_unconfigured" }, { status: 503 });
  }
  try {
    return NextResponse.json({ ...(await runAssistant({ messages, ip, actor })), auth: authInfo(actor) });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", scope: "assistant", msg: "run_failed", err: e instanceof Error ? e.message : "unknown" }));
    return NextResponse.json({ error: "The assistant hit a problem. Please try again, or open a ticket." }, { status: 502 });
  }
}
