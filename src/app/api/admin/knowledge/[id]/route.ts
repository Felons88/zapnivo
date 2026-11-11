import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { getArticle, updateArticle, type ArticlePatch } from "@/lib/knowledge/db";
import { serviceClient } from "@/lib/supabase";

const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const optDate = z.string().trim().nullable().optional().transform((v, ctx) => {
  if (v === undefined || v === null || v === "") return v === "" ? null : v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: "custom", message: "effective_at must be a valid date." });
    return z.NEVER;
  }
  return d.toISOString();
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(50_000).optional(),
  category: optText(80),
  effective_at: optDate,
  source_ref: optText(300),
}).strict();

/** Staff-only single-article read. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const { id } = await params;
  const article = await getArticle(db, id);
  if (!article) return NextResponse.json({ error: "Article not found." }, { status: 404 });
  return NextResponse.json({ article });
}

/** Edits title/body/category/effective_at/source_ref. Content edits reset to draft. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const { id } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid patch.", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
  }
  const patch: ArticlePatch = {};
  const d = parsed.data;
  if (d.title !== undefined) patch.title = d.title;
  if (d.body !== undefined) patch.body = d.body;
  if (d.category !== undefined) patch.category = d.category;
  if (d.effective_at !== undefined) patch.effective_at = d.effective_at;
  if (d.source_ref !== undefined) patch.source_ref = d.source_ref;
  if (!Object.keys(patch).length) return NextResponse.json({ error: "Nothing to update." }, { status: 422 });

  const actorId = /^[0-9a-f-]{36}$/i.test(user!.id) ? user!.id : null;
  const result = await updateArticle(db, id, patch, actorId);
  if (!result.ok) {
    const status = result.error === "Article not found." ? 404 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ article: result.article });
}
