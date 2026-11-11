import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { createArticle, listArticles, KNOWLEDGE_AUDIENCES, KNOWLEDGE_STATUSES, type KnowledgeAudience, type KnowledgeStatus } from "@/lib/knowledge/db";
import { serviceClient } from "@/lib/supabase";

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,80}$/, "Slug: lowercase letters, numbers and dashes.");
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));
const optDate = z.string().trim().optional().transform((v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "invalid" : d.toISOString();
});

const createSchema = z.object({
  id: slug,
  title: z.string().trim().min(1).max(200),
  audience: z.enum(KNOWLEDGE_AUDIENCES as unknown as [KnowledgeAudience, ...KnowledgeAudience[]]),
  category: optText(80),
  body: z.string().trim().min(1).max(50_000),
  source_ref: optText(300),
  effective_at: optDate,
});

/** Staff-only knowledge article list/create. */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const audience = url.searchParams.get("audience");
  const filters: { status?: KnowledgeStatus; audience?: KnowledgeAudience } = {};
  if (status && (KNOWLEDGE_STATUSES as readonly string[]).includes(status)) filters.status = status as KnowledgeStatus;
  if (audience && (KNOWLEDGE_AUDIENCES as readonly string[]).includes(audience)) filters.audience = audience as KnowledgeAudience;

  const articles = await listArticles(db, filters);
  return NextResponse.json({ articles });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid article.", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
  }
  if (parsed.data.effective_at === "invalid") return NextResponse.json({ error: "effective_at must be a valid date." }, { status: 422 });

  const actorId = /^[0-9a-f-]{36}$/i.test(user!.id) ? user!.id : null;
  const result = await createArticle(db, {
    ...parsed.data,
    effective_at: parsed.data.effective_at === "invalid" ? null : parsed.data.effective_at,
    created_by: actorId,
  });
  if (!result.ok) {
    const status = result.error.includes("duplicate") || result.error.includes("unique") ? 409 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ article: result.article }, { status: 201 });
}
