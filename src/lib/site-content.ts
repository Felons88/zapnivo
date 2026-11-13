import { unstable_cache } from "next/cache";
import { serviceClient } from "./supabase";

/**
 * PUBLIC read path for CMS-managed site content (migration 0058).
 *
 * Contract for live pages:
 *  - NEVER throws — any backend/parse failure resolves to {} so pages fall back
 *    to their hardcoded copy.
 *  - Returns a field_key → published value map for one (site, page, locale).
 *  - Cached ~60s via unstable_cache; draft edits never leak here.
 *
 * Serving rules (match src/lib/system/site-cms.ts lifecycle):
 *  - status 'published'            → published_value is live
 *  - status 'draft'                → published_value (if any) stays live while
 *                                    a newer draft waits — drafts never unpublish
 *  - status 'scheduled'            → published_value (the snapshot) goes live only
 *                                    once scheduled_at has passed
 */

export type PublishedContent = Record<string, unknown>;

const LOCALE = "en";
const TTL_SECONDS = 60;

/**
 * Pure serving rule (unit tested): is this row's published_value live right now?
 *  - 'published' → yes
 *  - 'draft'     → yes when published_value exists (a pending draft never unpublishes)
 *  - 'scheduled' → yes only once scheduled_at has passed (snapshot in published_value)
 */
export function isContentLive(status: unknown, scheduledAt: unknown, now = Date.now()): boolean {
  if (status === "published" || status === "draft") return true;
  if (status === "scheduled") {
    const at = typeof scheduledAt === "string" ? Date.parse(scheduledAt) : NaN;
    return Number.isFinite(at) && at <= now;
  }
  return false;
}

async function fetchPublished(siteKey: string, pageKey: string): Promise<PublishedContent> {
  const db = serviceClient();
  if (!db) return {};
  try {
    const { data, error } = await db
      .from("site_content")
      .select("field_key,published_value,status,scheduled_at")
      .eq("site_key", siteKey)
      .eq("page_key", pageKey)
      .eq("locale", LOCALE)
      .not("published_value", "is", null)
      .limit(500);
    if (error || !Array.isArray(data)) return {};
    const now = Date.now();
    const out: PublishedContent = {};
    for (const r of data as {
      field_key?: unknown;
      published_value?: unknown;
      status?: unknown;
      scheduled_at?: unknown;
    }[]) {
      if (typeof r.field_key !== "string") continue;
      if (!isContentLive(r.status, r.scheduled_at, now)) continue;
      out[r.field_key] = r.published_value;
    }
    return out;
  } catch {
    return {};
  }
}

const cachedFetch = unstable_cache(fetchPublished, ["site-content"], { revalidate: TTL_SECONDS });

/**
 * Published field values for a site page. Missing backend, missing table, or
 * any error → {} (callers keep their hardcoded defaults).
 */
export async function getPublishedContent(siteKey: string, pageKey: string): Promise<PublishedContent> {
  try {
    return await cachedFetch(siteKey, pageKey);
  } catch {
    return {};
  }
}

/** Convenience: string field or fallback. */
export function text(content: PublishedContent, key: string, fallback: string): string {
  const v = content[key];
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

/** Convenience: boolean field or fallback. */
export function flag(content: PublishedContent, key: string, fallback: boolean): boolean {
  const v = content[key];
  return typeof v === "boolean" ? v : fallback;
}
