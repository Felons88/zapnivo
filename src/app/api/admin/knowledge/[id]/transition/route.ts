import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { KNOWLEDGE_STATUSES, transition, type KnowledgeStatus } from "@/lib/knowledge/db";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({
  to: z.enum(KNOWLEDGE_STATUSES as unknown as [KnowledgeStatus, ...KnowledgeStatus[]]),
}).strict();

/** Staff-only lifecycle transition: submit / approve / publish / reject / archive. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const { id } = await params;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid transition." }, { status: 422 });

  const actorId = /^[0-9a-f-]{36}$/i.test(user!.id) ? user!.id : null;
  const result = await transition(db, id, parsed.data.to, actorId);
  if (!result.ok) {
    const status = result.error === "Article not found." ? 404 : 422;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ article: result.article });
}
