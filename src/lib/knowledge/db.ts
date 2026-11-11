import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "@/lib/observability";
import {
  AUDIENCE_SEES,
  type ArticlePatch,
  type KnowledgeArticle,
  type KnowledgeAudience,
  type KnowledgeStatus,
  type KnowledgeVersion,
  type PublishedArticle,
  type StaleArticle,
  type StaleReason,
  type TransitionResult,
} from "./types";

/**
 * DB-backed knowledge lifecycle (migration 0029). Complements — never replaces —
 * the static-file KB in src/lib/ai/knowledge.ts. Every function takes the DB
 * client explicitly so callers stay auditable; routes do their own auth.
 *
 * Lifecycle: draft → in_review → approved → published → archived.
 * Content edits (title/body) always knock an article back to draft — metadata
 * edits (category, effective_at, source_ref) keep the current status.
 * Server-only: imports observability/supabase — do not import from client code
 * (use ./types for shared constants and shapes).
 */

export type KnowledgeDb = SupabaseClient;

export {
  AUDIENCE_SEES,
  KNOWLEDGE_AUDIENCES,
  KNOWLEDGE_STATUSES,
  type ArticlePatch,
  type KnowledgeArticle,
  type KnowledgeAudience,
  type KnowledgeStatus,
  type KnowledgeVersion,
  type PublishedArticle,
  type StaleArticle,
  type StaleReason,
  type TransitionResult,
} from "./types";

const ARTICLE_COLS = "id,title,audience,category,body,status,version,effective_at,source_ref,reviewed_by,reviewed_at,created_by,created_at,updated_at";
const PUBLISHED_COLS = "id,title,audience,category,body,version,effective_at,updated_at";

const asArticle = (row: unknown): KnowledgeArticle => row as KnowledgeArticle;

export async function listArticles(
  db: KnowledgeDb,
  filters: { status?: KnowledgeStatus; audience?: KnowledgeAudience } = {},
): Promise<KnowledgeArticle[]> {
  let q = db.from("knowledge_articles").select(ARTICLE_COLS).order("updated_at", { ascending: false }).limit(500);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.audience) q = q.eq("audience", filters.audience);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []).map(asArticle);
}

export async function getArticle(db: KnowledgeDb, id: string): Promise<KnowledgeArticle | null> {
  const { data, error } = await db.from("knowledge_articles").select(ARTICLE_COLS).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return asArticle(data);
}

/**
 * Appends one immutable snapshot row to knowledge_versions. `version` is a
 * per-article change sequence (max+1) — every mutation archives the OUTGOING
 * state, so the table reads as the history of what each change replaced.
 * Read-then-write is fine at this scale; add a retry if write volume grows.
 */
async function appendVersion(
  db: KnowledgeDb,
  article: KnowledgeArticle,
  changedBy: string | null,
  snapshot: { title: string; body: string; status: KnowledgeStatus },
): Promise<void> {
  const { data: prev } = await db
    .from("knowledge_versions")
    .select("version")
    .eq("article_id", article.id)
    .order("version", { ascending: false })
    .limit(1);
  const version = (((prev?.[0] as { version?: number } | undefined)?.version) ?? 0) + 1;
  await db.from("knowledge_versions").insert({
    article_id: article.id,
    version,
    title: snapshot.title,
    body: snapshot.body,
    status: snapshot.status,
    changed_by: changedBy,
  } satisfies Partial<KnowledgeVersion>);
}

export type CreateArticleInput = {
  id: string;
  title: string;
  audience: KnowledgeAudience;
  category?: string | null;
  body: string;
  source_ref?: string | null;
  effective_at?: string | null;
  created_by?: string | null;
};

export async function createArticle(db: KnowledgeDb, input: CreateArticleInput): Promise<TransitionResult> {
  const { data, error } = await db.from("knowledge_articles").insert({
    id: input.id,
    title: input.title,
    audience: input.audience,
    category: input.category ?? null,
    body: input.body,
    status: "draft",
    version: 1,
    effective_at: input.effective_at ?? null,
    source_ref: input.source_ref ?? null,
    created_by: input.created_by ?? null,
  }).select(ARTICLE_COLS).single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't create the article." };
  const article = asArticle(data);
  await appendVersion(db, article, input.created_by ?? null, { title: article.title, body: article.body, status: "draft" });
  recordLog("info", "knowledge.article_created", { service: "knowledge", attrs: { id: article.id, audience: article.audience } });
  return { ok: true, article };
}

/**
 * Edits an article. Snapshots the current row into knowledge_versions, bumps
 * `version`, and resets status to 'draft' (clearing the reviewer) when title or
 * body changed — content edits require re-review. Metadata-only edits keep status.
 */
export async function updateArticle(
  db: KnowledgeDb,
  id: string,
  patch: ArticlePatch,
  changedBy: string | null,
): Promise<TransitionResult> {
  const current = await getArticle(db, id);
  if (!current) return { ok: false, error: "Article not found." };

  const contentChanged =
    (patch.title !== undefined && patch.title !== current.title) ||
    (patch.body !== undefined && patch.body !== current.body);

  await appendVersion(db, current, changedBy, { title: current.title, body: current.body, status: current.status });

  const update: Record<string, unknown> = { version: current.version + 1 };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.body !== undefined) update.body = patch.body;
  if (patch.category !== undefined) update.category = patch.category;
  if (patch.effective_at !== undefined) update.effective_at = patch.effective_at;
  if (patch.source_ref !== undefined) update.source_ref = patch.source_ref;
  if (contentChanged) {
    update.status = "draft";
    update.reviewed_by = null;
    update.reviewed_at = null;
  }

  const { data, error } = await db.from("knowledge_articles").update(update).eq("id", id).select(ARTICLE_COLS).single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't update the article." };
  const article = asArticle(data);
  recordLog("info", "knowledge.article_updated", {
    service: "knowledge",
    attrs: { id, version: article.version, content_changed: contentChanged, status: article.status },
  });
  return { ok: true, article };
}

/** Allowed lifecycle edges. "any → archived" is expressed per-state. */
const TRANSITIONS: Record<KnowledgeStatus, readonly KnowledgeStatus[]> = {
  draft: ["in_review", "archived"],
  in_review: ["approved", "draft", "archived"],
  approved: ["published", "archived"],
  published: ["archived"],
  archived: [],
};

/**
 * Moves an article along the lifecycle. in_review→approved stamps the reviewer;
 * approved→published requires effective_at to be unset or already past. Every
 * transition archives the outgoing state in knowledge_versions.
 */
export async function transition(db: KnowledgeDb, id: string, to: KnowledgeStatus, staffId: string | null): Promise<TransitionResult> {
  const current = await getArticle(db, id);
  if (!current) return { ok: false, error: "Article not found." };
  if (current.status === "archived") return { ok: false, error: "Archived articles can't transition." };
  if (!TRANSITIONS[current.status].includes(to)) {
    return { ok: false, error: `Can't move an article from ${current.status} to ${to}.` };
  }
  if (to === "published") {
    if (current.effective_at && Date.parse(current.effective_at) > Date.now()) {
      return { ok: false, error: "effective_at is in the future — publish once it takes effect." };
    }
  }

  await appendVersion(db, current, staffId, { title: current.title, body: current.body, status: current.status });

  const update: Record<string, unknown> = { status: to };
  if (to === "approved") {
    update.reviewed_by = staffId;
    update.reviewed_at = new Date().toISOString();
  }

  const { data, error } = await db.from("knowledge_articles").update(update).eq("id", id).select(ARTICLE_COLS).single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't transition the article." };
  const article = asArticle(data);
  recordLog("info", "knowledge.article_transition", {
    service: "knowledge",
    attrs: { id, from: current.status, to, version: article.version },
  });
  return { ok: true, article };
}

/** Published articles visible to a reader audience, minimal retrieval fields. */
export async function publishedForAudience(db: KnowledgeDb, audience: KnowledgeAudience): Promise<PublishedArticle[]> {
  const { data, error } = await db
    .from("knowledge_articles")
    .select(PUBLISHED_COLS)
    .eq("status", "published")
    .in("audience", [...AUDIENCE_SEES[audience]])
    .order("title", { ascending: true })
    .limit(200);
  if (error) return [];
  return (data ?? []) as unknown as PublishedArticle[];
}

const STALE_EFFECTIVE_MS = 180 * 24 * 60 * 60 * 1000;
const STALE_UPDATED_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Published articles due for review: effective_at older than 180 days, or not
 * updated in 365 days. Returns flags only — never auto-archives.
 */
export async function staleReport(db: KnowledgeDb, now = Date.now()): Promise<StaleArticle[]> {
  const { data, error } = await db
    .from("knowledge_articles")
    .select("id,title,audience,category,status,version,effective_at,updated_at")
    .eq("status", "published")
    .limit(1000);
  if (error) return [];
  const out: StaleArticle[] = [];
  for (const row of (data ?? []) as unknown as StaleArticle[]) {
    const reasons: StaleReason[] = [];
    if (row.effective_at && now - Date.parse(row.effective_at) > STALE_EFFECTIVE_MS) reasons.push("effective_at");
    if (row.updated_at && now - Date.parse(row.updated_at) > STALE_UPDATED_MS) reasons.push("updated_at");
    if (reasons.length) out.push({ ...row, reasons });
  }
  return out;
}

/** Simple title/body substring search over articles published to an audience. */
export async function searchPublished(db: KnowledgeDb, query: string, audience: KnowledgeAudience, limit = 10): Promise<PublishedArticle[]> {
  // ilike metachars + the or() separator must not survive into the filter.
  const q = query.replace(/[%_,()"\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!q) return [];
  const { data, error } = await db
    .from("knowledge_articles")
    .select(PUBLISHED_COLS)
    .eq("status", "published")
    .in("audience", [...AUDIENCE_SEES[audience]])
    .or(`title.ilike.*${q}*,body.ilike.*${q}*`)
    .order("title", { ascending: true })
    .limit(Math.max(1, Math.min(50, Math.round(limit))));
  if (error) return [];
  return (data ?? []) as unknown as PublishedArticle[];
}
