/**
 * Shared knowledge-lifecycle types + constants. Pure module — safe to import
 * from client components (unlike db.ts, which is server-only).
 */

export type KnowledgeAudience = "public" | "customer" | "partner" | "internal";
export type KnowledgeStatus = "draft" | "in_review" | "approved" | "published" | "archived";
export const KNOWLEDGE_AUDIENCES: readonly KnowledgeAudience[] = ["public", "customer", "partner", "internal"];
export const KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = ["draft", "in_review", "approved", "published", "archived"];

export type KnowledgeArticle = {
  id: string;
  title: string;
  audience: KnowledgeAudience;
  category: string | null;
  body: string;
  status: KnowledgeStatus;
  version: number;
  effective_at: string | null;
  source_ref: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type KnowledgeVersion = {
  id: number;
  article_id: string;
  version: number;
  title: string;
  body: string;
  status: KnowledgeStatus;
  changed_by: string | null;
  created_at: string;
};

/** Which article audiences each reader audience may see (published only). */
export const AUDIENCE_SEES: Record<KnowledgeAudience, readonly KnowledgeAudience[]> = {
  public: ["public"],
  customer: ["public", "customer"],
  partner: ["public", "partner"],
  internal: ["public", "customer", "partner", "internal"],
};

/** Minimal shape handed to retrieval callers. */
export type PublishedArticle = Pick<KnowledgeArticle, "id" | "title" | "audience" | "category" | "body" | "version" | "effective_at" | "updated_at">;

export type ArticlePatch = {
  title?: string;
  body?: string;
  category?: string | null;
  /** undefined = unchanged; null = clear the effective date. */
  effective_at?: string | null;
  source_ref?: string | null;
};

export type TransitionResult = { ok: true; article: KnowledgeArticle } | { ok: false; error: string };

export type StaleReason = "effective_at" | "updated_at";
export type StaleArticle = Pick<KnowledgeArticle, "id" | "title" | "audience" | "category" | "status" | "version" | "effective_at" | "updated_at"> & {
  reasons: StaleReason[];
};
