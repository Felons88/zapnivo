import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, type SystemActor } from "./audit";
import { isSiteKey, type CmsResult } from "./site-cms";

/**
 * Website Management Center — media library (migration 0061).
 *
 * Bytes live in the PRIVATE Supabase Storage bucket 'site-media' and are only
 * touched through the service role. This module owns:
 *  - upload validation: MIME whitelist (SVG rejected — script-capable), size
 *    cap, and magic-byte sniffing so the declared Content-Type is never trusted;
 *  - the site_media registry rows (path/url/alt/category/archived);
 *  - usage tracking: image fields reference media by storage path or serve URL,
 *    and delete is BLOCKED while published or draft content still references it;
 *  - public serving metadata: images are served same-origin via
 *    /api/system/sites/media/file/[id] (see src/app/api/system/sites/media/).
 *
 * Everything here fails closed: unknown site keys, bad input, or a missing
 * backend return honest errors — nothing is faked.
 */

export const MEDIA_BUCKET = "site-media";
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export const MEDIA_CATEGORIES = [
  "general", "brand", "kiosk", "powerbank", "homepage", "partner", "ads", "help", "newsletter",
] as const;
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];
export const isMediaCategory = (v: unknown): v is MediaCategory =>
  typeof v === "string" && (MEDIA_CATEGORIES as readonly string[]).includes(v);

/** Raster formats only — SVG is deliberately excluded (script-capable markup). */
export const MEDIA_MIMES = [
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
] as const;
export type MediaMime = (typeof MEDIA_MIMES)[number];

const EXT_FOR_MIME: Record<MediaMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};
export const extForMediaMime = (mime: MediaMime): string => EXT_FOR_MIME[mime];

const MIME_FOR_EXT: Record<string, MediaMime> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", avif: "image/avif",
};

/** Same-origin serve path stored as site_media.url — kept unguessable via uuid id. */
export const mediaServePath = (id: string): string => `/api/system/sites/media/file/${id}`;

/* ── Variants (migration 0063) ────────────────────────────────────────────────
 * site_media.variants is a jsonb map of variant name → stored object info:
 *   { "thumb": { "path": "site/<uuid>.thumb.webp", "mime": "image/webp",
 *                "bytes": 1234, "width": 400, "height": 267 },
 *     "card":  { ... } }
 * Variants are regenerable derivatives of the ORIGINAL (always retained for
 * revisions/rollback). site_media.variant_error records the last processing
 * failure honestly ("" = none) so the UI can show "original only" instead of
 * pretending variants exist.
 */
export type MediaVariantInfo = {
  path: string;
  mime: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
};
export type MediaVariants = Partial<Record<"thumb" | "card", MediaVariantInfo>>;

const asVariantInfo = (v: unknown): MediaVariantInfo | null => {
  const r = v as Partial<MediaVariantInfo> | null;
  if (!r || typeof r.path !== "string" || r.path.length === 0) return null;
  return {
    path: r.path,
    mime: typeof r.mime === "string" ? r.mime : "image/webp",
    bytes: typeof r.bytes === "number" ? r.bytes : null,
    width: typeof r.width === "number" ? r.width : null,
    height: typeof r.height === "number" ? r.height : null,
  };
};

/** Defensive parse of the variants jsonb column — unknown keys dropped. */
export function parseMediaVariants(v: unknown): MediaVariants {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: MediaVariants = {};
  for (const key of ["thumb", "card"] as const) {
    const parsed = asVariantInfo((v as Record<string, unknown>)[key]);
    if (parsed) out[key] = parsed;
  }
  return out;
}

/** All storage paths owned by a media row: original + every variant. */
export function mediaStoragePaths(item: Pick<SiteMediaItem, "path" | "variants">): string[] {
  const paths = [item.path];
  for (const key of ["thumb", "card"] as const) {
    const p = item.variants?.[key]?.path;
    if (typeof p === "string" && p.length > 0) paths.push(p);
  }
  return paths;
}

export type MediaServeTarget = { path: string; mime: string | null };

/**
 * Resolves which storage object a serve request should return.
 * variant "original"/undefined → the retained original; "thumb"/"card" → the
 * named variant. Returns null when the requested variant doesn't exist —
 * callers decide between 404 and redirecting to the original.
 */
export function resolveMediaServeTarget(
  item: Pick<SiteMediaItem, "path" | "mime" | "variants">,
  variant: string | null | undefined,
): MediaServeTarget | null {
  if (!variant || variant === "original") return { path: item.path, mime: item.mime };
  if (variant === "thumb" || variant === "card") {
    const v = item.variants?.[variant];
    if (!v) return null;
    return { path: v.path, mime: v.mime };
  }
  return null; // unknown variant name
}

/* ── Magic-byte sniffing (pure — unit tested) ──────────────────────────────── */

const startsWith = (b: Uint8Array, sig: number[], offset = 0): boolean =>
  sig.every((byte, i) => b[offset + i] === byte);

/**
 * Detects the real image type from magic bytes. Returns null for anything that
 * isn't a whitelisted raster format — including SVG (text-based, no reliable
 * binary signature and script-capable) and every other payload.
 */
export function sniffImageMime(bytes: Uint8Array): MediaMime | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // GIF: "GIF87a" / "GIF89a"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  // WebP: "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  // AVIF/HEIC-family: ISO BMFF — check ftyp box brand at offset 8.
  if (startsWith(bytes, [0x00, 0x00, 0x00]) && bytes[3] >= 0x18 && bytes[3] <= 0x40 && startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

export type MediaUploadCheck =
  | { ok: true; mime: MediaMime; ext: string; bytes: number }
  | { ok: false; error: string };

/**
 * Validates an upload payload. `declaredMime` comes from the multipart part;
 * the REAL type is decided by magic bytes — a mismatch or non-image payload
 * is rejected. SVG is never accepted.
 */
export function validateMediaUpload(input: {
  fileName: string;
  declaredMime: string;
  bytes: Uint8Array;
}): MediaUploadCheck {
  if (input.bytes.length === 0) return { ok: false, error: "Empty file" };
  if (input.bytes.length > MEDIA_MAX_BYTES) {
    return { ok: false, error: `File too large — max ${Math.floor(MEDIA_MAX_BYTES / 1024 / 1024)} MB` };
  }
  const ext = input.fileName.split(".").pop()?.toLowerCase() ?? "";
  const extMime = MIME_FOR_EXT[ext];
  if (!extMime) return { ok: false, error: "Unsupported file type — use jpg, png, webp, gif or avif" };
  if ((MEDIA_MIMES as readonly string[]).includes(input.declaredMime) === false) {
    return { ok: false, error: `Unsupported content type '${input.declaredMime}' — SVG and non-image files are not allowed` };
  }
  const sniffed = sniffImageMime(input.bytes);
  if (!sniffed) return { ok: false, error: "File content is not a supported image" };
  // Declared mime, extension and magic bytes must all agree.
  if (sniffed !== extMime || sniffed !== input.declaredMime) {
    return { ok: false, error: "File type mismatch — the content doesn't match its extension/content type" };
  }
  return { ok: true, mime: sniffed, ext, bytes: input.bytes.length };
}

/* ── Row type ──────────────────────────────────────────────────────────────── */

export type SiteMediaItem = {
  id: string;
  site_key: string;
  path: string;
  url: string | null;
  alt_text: string;
  mime: string | null;
  bytes: number | null;
  storage_bucket: string | null;
  category: string;
  archived: boolean;
  width: number | null;
  height: number | null;
  variants: MediaVariants;
  variant_error: string | null;
  uploaded_by: string | null;
  created_at: string;
};

const MEDIA_COLS =
  "id,site_key,path,url,alt_text,mime,bytes,storage_bucket,category,archived,width,height,variants,variant_error,uploaded_by,created_at";

const asItem = (v: unknown): SiteMediaItem | null => {
  const r = v as Partial<SiteMediaItem> | null;
  if (!r || typeof r.id !== "string" || typeof r.path !== "string") return null;
  const item = r as SiteMediaItem;
  item.variants = parseMediaVariants((r as { variants?: unknown }).variants);
  item.variant_error = typeof r.variant_error === "string" && r.variant_error.length > 0 ? r.variant_error : null;
  return item;
};

/* ── Reads ─────────────────────────────────────────────────────────────────── */

export async function listSiteMedia(
  db: SupabaseClient | null,
  siteKey: string,
  opts: { category?: string; includeArchived?: boolean } = {},
): Promise<SiteMediaItem[]> {
  if (!db || !isSiteKey(siteKey)) return [];
  let q = db.from("site_media").select(MEDIA_COLS).eq("site_key", siteKey);
  if (opts.category && isMediaCategory(opts.category)) q = q.eq("category", opts.category);
  if (!opts.includeArchived) q = q.eq("archived", false);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
  if (error || !Array.isArray(data)) return [];
  return data.map(asItem).filter((r): r is SiteMediaItem => r !== null);
}

export async function getMediaItem(
  db: SupabaseClient | null,
  siteKey: string,
  id: string,
): Promise<SiteMediaItem | null> {
  if (!db || !isSiteKey(siteKey)) return null;
  const { data, error } = await db
    .from("site_media")
    .select(MEDIA_COLS)
    .eq("site_key", siteKey)
    .eq("id", id)
    .maybeSingle();
  if (error) return null;
  return asItem(data);
}

/** Lookup for the public serve route — by row id only, no site scoping needed. */
export async function getMediaById(db: SupabaseClient | null, id: string): Promise<SiteMediaItem | null> {
  if (!db) return null;
  const { data, error } = await db.from("site_media").select(MEDIA_COLS).eq("id", id).maybeSingle();
  if (error) return null;
  return asItem(data);
}

/* ── Usage tracking ────────────────────────────────────────────────────────── */

export type MediaUsageRef = { page_key: string; field_key: string; status: string };

/**
 * Finds site_content rows whose draft OR published value references this media
 * (by storage path or serve URL). Values are scalars but may be nested jsonb, so
 * we match on the serialized form — a substring hit on a full path/uuid URL is
 * specific enough that false positives are not a practical concern.
 */
export async function mediaUsageRefs(
  db: SupabaseClient | null,
  item: Pick<SiteMediaItem, "site_key" | "path" | "url">,
): Promise<MediaUsageRef[]> {
  if (!db) return [];
  const needles = [item.path, item.url].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (needles.length === 0) return [];
  const { data, error } = await db
    .from("site_content")
    .select("page_key,field_key,status,draft_value,published_value")
    .eq("site_key", item.site_key)
    .limit(2000);
  if (error || !Array.isArray(data)) return [];
  const refs: MediaUsageRef[] = [];
  for (const r of data as { page_key?: unknown; field_key?: unknown; status?: unknown; draft_value?: unknown; published_value?: unknown }[]) {
    const blob = JSON.stringify(r.draft_value ?? null) + "|" + JSON.stringify(r.published_value ?? null);
    if (needles.some((n) => blob.includes(n))) {
      refs.push({
        page_key: typeof r.page_key === "string" ? r.page_key : "",
        field_key: typeof r.field_key === "string" ? r.field_key : "",
        status: typeof r.status === "string" ? r.status : "",
      });
    }
  }
  return refs;
}

/* ── Mutations ─────────────────────────────────────────────────────────────── */

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

/**
 * Registers an already-uploaded blob: inserts the site_media row and returns it.
 * `bytes` is the raw file content; storage upload happens in the route BEFORE
 * this call — if the row insert fails the route removes the orphaned object.
 */
export async function registerMedia(
  db: SupabaseClient,
  actor: SystemActor,
  input: {
    siteKey: string;
    storagePath: string;
    mime: MediaMime;
    bytes: number;
    altText: string;
    category: MediaCategory;
    width?: number | null;
    height?: number | null;
    variants?: MediaVariants;
    variantError?: string | null;
  },
): Promise<CmsResult<SiteMediaItem>> {
  if (!isSiteKey(input.siteKey)) return fail(404, "Unknown site");
  const id = randomUUID();
  const { data, error } = await db
    .from("site_media")
    .insert({
      id,
      site_key: input.siteKey,
      path: input.storagePath,
      url: mediaServePath(id),
      alt_text: input.altText.slice(0, 300),
      mime: input.mime,
      bytes: input.bytes,
      storage_bucket: MEDIA_BUCKET,
      category: input.category,
      width: input.width ?? null,
      height: input.height ?? null,
      variants: input.variants ?? {},
      variant_error: input.variantError ?? null,
      uploaded_by: actor.id,
    })
    .select(MEDIA_COLS)
    .single();
  if (error || !data) return fail(500, error?.message ?? "media register failed");
  const item = asItem(data);
  if (!item) return fail(500, "media register failed");
  await systemAudit(db, {
    actor,
    action: "sitemedia.uploaded",
    resource: `site_media:${input.siteKey}/${id}`,
    detail: { site: input.siteKey, path: input.storagePath, mime: input.mime, bytes: input.bytes, category: input.category },
  });
  return { ok: true, data: item };
}

/** Updates alt text / category / archived flag. All fields optional. */
export async function updateMediaMeta(
  db: SupabaseClient,
  actor: SystemActor,
  siteKey: string,
  id: string,
  patch: { altText?: string; category?: MediaCategory; archived?: boolean },
): Promise<CmsResult<SiteMediaItem>> {
  if (!isSiteKey(siteKey)) return fail(404, "Unknown site");
  const fields: Record<string, unknown> = {};
  if (patch.altText !== undefined) fields.alt_text = patch.altText.slice(0, 300);
  if (patch.category !== undefined) fields.category = patch.category;
  if (patch.archived !== undefined) fields.archived = patch.archived;
  if (Object.keys(fields).length === 0) return fail(422, "Nothing to update");

  const existing = await getMediaItem(db, siteKey, id);
  if (!existing) return fail(404, "Media not found");

  const { data, error } = await db
    .from("site_media")
    .update(fields)
    .eq("id", id)
    .eq("site_key", siteKey)
    .select(MEDIA_COLS)
    .single();
  if (error || !data) return fail(500, error?.message ?? "media update failed");
  const item = asItem(data);
  if (!item) return fail(500, "media update failed");
  await systemAudit(db, {
    actor,
    action: patch.archived === true ? "sitemedia.archived" : patch.archived === false ? "sitemedia.unarchived" : "sitemedia.updated",
    resource: `site_media:${siteKey}/${id}`,
    detail: { site: siteKey, fields: Object.keys(fields) },
  });
  return { ok: true, data: item };
}

export type DeleteMediaResult =
  | { ok: true }
  | { ok: false; status: number; error: string; refs?: MediaUsageRef[] };

/**
 * Hard-deletes media: removes the storage object AND the registry row.
 * BLOCKED (409) while any site_content draft/published value still references
 * the path or serve URL — callers must archive instead. Storage removal
 * failures after row checks are reported honestly; the row is only deleted
 * after the object removal succeeds (or the object is already gone).
 */
export async function deleteMedia(
  db: SupabaseClient,
  actor: SystemActor,
  siteKey: string,
  id: string,
): Promise<DeleteMediaResult> {
  if (!isSiteKey(siteKey)) return { ok: false, status: 404, error: "Unknown site" };
  const item = await getMediaItem(db, siteKey, id);
  if (!item) return { ok: false, status: 404, error: "Media not found" };

  const refs = await mediaUsageRefs(db, item);
  if (refs.length > 0) {
    return {
      ok: false,
      status: 409,
      error: "Media is referenced by content — remove the references or archive it instead",
      refs,
    };
  }

  if (item.storage_bucket) {
    // Remove the original AND every variant in one call — variants are
    // regenerable derivatives but must never be orphaned in the bucket.
    const { error: rmErr } = await db.storage.from(item.storage_bucket).remove(mediaStoragePaths(item));
    // A missing object is fine (already gone); anything else is a real failure.
    if (rmErr && !/not.?found|does not exist/i.test(rmErr.message)) {
      return { ok: false, status: 500, error: `Storage delete failed: ${rmErr.message}` };
    }
  }

  const { error } = await db.from("site_media").delete().eq("id", id).eq("site_key", siteKey);
  if (error) return { ok: false, status: 500, error: error.message };
  await systemAudit(db, {
    actor,
    action: "sitemedia.deleted",
    resource: `site_media:${siteKey}/${id}`,
    detail: { site: siteKey, path: item.path },
  });
  return { ok: true };
}
