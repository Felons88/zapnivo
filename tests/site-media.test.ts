import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MEDIA_BUCKET, MEDIA_CATEGORIES, MEDIA_MAX_BYTES, extForMediaMime,
  isMediaCategory, mediaServePath, mediaStoragePaths, mediaUsageRefs, parseMediaVariants,
  registerMedia, resolveMediaServeTarget, deleteMedia, getMediaItem, listSiteMedia,
  sniffImageMime, updateMediaMeta,
  validateMediaUpload, type SiteMediaItem,
} from "@/lib/system/site-media";
import type { SystemActor } from "@/lib/system/audit";

/* ── Minimal Supabase stub (same shape as tests/site-cms.test.ts) ──────────── */

type Result = { data?: unknown; error?: { message: string } | null };
type TableState = {
  queue: Result[];
  inserted: unknown[];
  updated: { payload: unknown }[];
  deleted: unknown[];
};

function fakeTable() {
  const state: TableState = { queue: [], inserted: [], updated: [], deleted: [] };
  const b: Record<string, unknown> = {};
  const next = (): Result => state.queue.length ? state.queue.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "filter", "limit"]) {
    b[m] = () => b;
  }
  b.delete = () => { state.deleted.push(true); return b; };
  b.insert = (row: unknown) => { state.inserted.push(row); return b; };
  b.update = (payload: unknown) => { state.updated.push({ payload }); return b; };
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(next()).then(res, rej);
  (b as { _state?: TableState })._state = state;
  return b;
}

function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>, opts: { storageRemoveError?: string | null } = {}) {
  const removed: string[][] = [];
  const db = {
    from: (t: string) => tables[t] ?? fakeTable(),
    storage: {
      from: (_bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { data: paths.map((name) => ({ name })), error: opts.storageRemoveError ? { message: opts.storageRemoveError } : null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { db, removed };
}
const stateOf = (t: ReturnType<typeof fakeTable>) => (t as unknown as { _state: TableState })._state;

const actor: SystemActor = { id: "user-1", role: "sysadmin" };

/* ── Byte fixtures ─────────────────────────────────────────────────────────── */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0]);
const AVIF = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0, 0x61, 0x76, 0x69, 0x66]);
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

/* ── Magic-byte sniffing ───────────────────────────────────────────────────── */

describe("sniffImageMime", () => {
  it("detects each whitelisted raster format", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(AVIF)).toBe("image/avif");
  });
  it("rejects SVG, executables, text and truncated files", () => {
    expect(sniffImageMime(SVG)).toBeNull();
    expect(sniffImageMime(EXE)).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("hello world, this is plain text"))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
  });
});

/* ── Upload validation ─────────────────────────────────────────────────────── */

describe("validateMediaUpload", () => {
  it("accepts a consistent image (ext + declared mime + magic bytes agree)", () => {
    const r = validateMediaUpload({ fileName: "hero.PNG", declaredMime: "image/png", bytes: PNG });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.mime).toBe("image/png"); expect(r.ext).toBe("png"); expect(r.bytes).toBe(PNG.length); }
  });
  it("rejects SVG even with an image extension and image mime", () => {
    const r = validateMediaUpload({ fileName: "logo.png", declaredMime: "image/png", bytes: SVG });
    expect(r.ok).toBe(false);
  });
  it("rejects declared svg mime outright", () => {
    const r = validateMediaUpload({ fileName: "icon.svg", declaredMime: "image/svg+xml", bytes: SVG });
    expect(r.ok).toBe(false);
  });
  it("rejects extension/content-type mismatch and spoofed mime", () => {
    expect(validateMediaUpload({ fileName: "evil.jpg", declaredMime: "image/png", bytes: JPEG }).ok).toBe(false);
    expect(validateMediaUpload({ fileName: "evil.png", declaredMime: "image/png", bytes: EXE }).ok).toBe(false);
    expect(validateMediaUpload({ fileName: "evil.gif", declaredMime: "image/gif", bytes: JPEG }).ok).toBe(false);
  });
  it("rejects disallowed extensions and oversize files", () => {
    expect(validateMediaUpload({ fileName: "doc.pdf", declaredMime: "application/pdf", bytes: EXE }).ok).toBe(false);
    const big = new Uint8Array(MEDIA_MAX_BYTES + 1);
    big.set(PNG.subarray(0, 16));
    expect(validateMediaUpload({ fileName: "big.png", declaredMime: "image/png", bytes: big }).ok).toBe(false);
    expect(validateMediaUpload({ fileName: "empty.png", declaredMime: "image/png", bytes: new Uint8Array(0) }).ok).toBe(false);
  });
});

describe("media constants", () => {
  it("categories and mime helpers are consistent", () => {
    for (const c of MEDIA_CATEGORIES) expect(isMediaCategory(c)).toBe(true);
    expect(isMediaCategory("nonsense")).toBe(false);
    expect(isMediaCategory(42)).toBe(false);
    expect(extForMediaMime("image/jpeg")).toBe("jpg");
    expect(MEDIA_BUCKET).toBe("site-media");
    expect(mediaServePath("abc")).toBe("/api/system/sites/media/file/abc");
  });
});

/* ── Registry rows ─────────────────────────────────────────────────────────── */

const item = (over: Partial<SiteMediaItem> = {}): SiteMediaItem => ({
  id: "11111111-1111-1111-1111-111111111111",
  site_key: "apex",
  path: "apex/abc.png",
  url: "/api/system/sites/media/file/11111111-1111-1111-1111-111111111111",
  alt_text: "Hero image",
  mime: "image/png",
  bytes: 1234,
  storage_bucket: MEDIA_BUCKET,
  category: "homepage",
  archived: false,
  width: null,
  height: null,
  variants: {},
  variant_error: null,
  uploaded_by: "user-1",
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("listSiteMedia", () => {
  it("returns [] for unknown site or missing backend", async () => {
    expect(await listSiteMedia(null, "apex")).toEqual([]);
    expect(await listSiteMedia(null, "nope")).toEqual([]);
    const { db } = fakeDb({});
    expect(await listSiteMedia(db, "nope")).toEqual([]);
  });
  it("maps rows and filters archived by default", async () => {
    const media = fakeTable();
    const { db } = fakeDb({ site_media: media });
    stateOf(media).queue.push({ data: [item()], error: null });
    const rows = await listSiteMedia(db, "apex");
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("homepage");
    expect(rows[0].archived).toBe(false);
  });
});

describe("registerMedia", () => {
  it("inserts a row with serve url, category and uploader", async () => {
    const media = fakeTable();
    const audit = fakeTable();
    const { db } = fakeDb({ site_media: media, system_audit_events: audit });
    stateOf(media).queue.push({ data: item(), error: null });
    const res = await registerMedia(db, actor, {
      siteKey: "apex", storagePath: "apex/x.png", mime: "image/png", bytes: 10,
      altText: "Alt", category: "brand",
    });
    expect(res.ok).toBe(true);
    const ins = stateOf(media).inserted[0] as Record<string, unknown>;
    expect(ins.storage_bucket).toBe(MEDIA_BUCKET);
    expect(ins.category).toBe("brand");
    expect(String(ins.url)).toMatch(/^\/api\/system\/sites\/media\/file\//);
    expect(stateOf(audit).inserted[0]).toMatchObject({ action: "sitemedia.uploaded" });
  });
  it("rejects unknown site keys", async () => {
    const { db } = fakeDb({});
    const res = await registerMedia(db, actor, {
      siteKey: "nope", storagePath: "x.png", mime: "image/png", bytes: 1, altText: "a", category: "general",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});

/* ── Update / archive ──────────────────────────────────────────────────────── */

describe("updateMediaMeta", () => {
  it("archives and unarchives with audit actions", async () => {
    const media = fakeTable();
    const audit = fakeTable();
    const { db } = fakeDb({ site_media: media, system_audit_events: audit });
    // getMediaItem lookup, then update().single()
    stateOf(media).queue.push({ data: item(), error: null }, { data: item({ archived: true }), error: null });
    const res = await updateMediaMeta(db, actor, "apex", item().id, { archived: true });
    expect(res.ok).toBe(true);
    expect(stateOf(media).updated[0].payload).toMatchObject({ archived: true });
    expect(stateOf(audit).inserted[0]).toMatchObject({ action: "sitemedia.archived" });

    stateOf(media).queue.push({ data: item({ archived: true }), error: null }, { data: item({ archived: false }), error: null });
    const res2 = await updateMediaMeta(db, actor, "apex", item().id, { archived: false });
    expect(res2.ok).toBe(true);
    expect(stateOf(audit).inserted[1]).toMatchObject({ action: "sitemedia.unarchived" });
  });
  it("404s on missing media and 422s on empty patch", async () => {
    const media = fakeTable();
    const { db } = fakeDb({ site_media: media });
    stateOf(media).queue.push({ data: null, error: null });
    const missing = await updateMediaMeta(db, actor, "apex", item().id, { archived: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);
    const empty = await updateMediaMeta(db, actor, "apex", item().id, {});
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.status).toBe(422);
  });
});

/* ── Usage refs + delete safeguards ────────────────────────────────────────── */

describe("mediaUsageRefs", () => {
  it("matches content rows referencing path or serve url", async () => {
    const content = fakeTable();
    const { db } = fakeDb({ site_content: content });
    const m = item();
    stateOf(content).queue.push({
      data: [
        { page_key: "home", field_key: "hero_image", status: "published", draft_value: null, published_value: m.url },
        { page_key: "home", field_key: "other", status: "draft", draft_value: "unrelated", published_value: null },
        { page_key: "footer", field_key: "logo", status: "published", draft_value: null, published_value: m.path },
      ],
      error: null,
    });
    const refs = await mediaUsageRefs(db, m);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.field_key).sort()).toEqual(["hero_image", "logo"]);
  });
  it("returns [] when backend missing or no needles", async () => {
    expect(await mediaUsageRefs(null, item())).toEqual([]);
    const { db } = fakeDb({});
    expect(await mediaUsageRefs(db, { site_key: "apex", path: "", url: null })).toEqual([]);
  });
});

describe("deleteMedia", () => {
  it("blocks deletion (409) while content references the media", async () => {
    const media = fakeTable();
    const content = fakeTable();
    const { db, removed } = fakeDb({ site_media: media, site_content: content });
    const m = item();
    stateOf(media).queue.push({ data: m, error: null }); // getMediaItem
    stateOf(content).queue.push({
      data: [{ page_key: "home", field_key: "hero_image", status: "published", draft_value: null, published_value: m.url }],
      error: null,
    });
    const res = await deleteMedia(db, actor, "apex", m.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.refs).toHaveLength(1);
    }
    expect(removed).toHaveLength(0); // storage untouched
    expect(stateOf(media).deleted).toHaveLength(0);
  });

  it("deletes storage object then row when unreferenced", async () => {
    const media = fakeTable();
    const content = fakeTable();
    const audit = fakeTable();
    const { db, removed } = fakeDb({ site_media: media, site_content: content, system_audit_events: audit });
    const m = item();
    stateOf(media).queue.push({ data: m, error: null }); // getMediaItem
    stateOf(content).queue.push({ data: [], error: null }); // usage scan
    const res = await deleteMedia(db, actor, "apex", m.id);
    expect(res.ok).toBe(true);
    expect(removed).toEqual([[m.path]]);
    expect(stateOf(media).deleted).toHaveLength(1);
    expect(stateOf(audit).inserted[0]).toMatchObject({ action: "sitemedia.deleted" });
  });

  it("surfaces storage delete failures honestly", async () => {
    const media = fakeTable();
    const content = fakeTable();
    const { db } = fakeDb({ site_media: media, site_content: content }, { storageRemoveError: "boom" });
    const m = item();
    stateOf(media).queue.push({ data: m, error: null });
    stateOf(content).queue.push({ data: [], error: null });
    const res = await deleteMedia(db, actor, "apex", m.id);
    expect(res.ok).toBe(false);
    if (!res.ok) { expect(res.status).toBe(500); expect(res.error).toContain("boom"); }
    expect(stateOf(media).deleted).toHaveLength(0);
  });

  it("404s on unknown site or missing media", async () => {
    const { db } = fakeDb({});
    const bad = await deleteMedia(db, actor, "nope", item().id);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(404);
    const media = fakeTable();
    const content = fakeTable();
    const { db: db2 } = fakeDb({ site_media: media, site_content: content });
    stateOf(media).queue.push({ data: null, error: null });
    const missing = await deleteMedia(db2, actor, "apex", item().id);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);
  });
});

describe("getMediaItem", () => {
  it("scopes lookup by site and id", async () => {
    const media = fakeTable();
    const { db } = fakeDb({ site_media: media });
    stateOf(media).queue.push({ data: item(), error: null });
    const found = await getMediaItem(db, "apex", item().id);
    expect(found?.id).toBe(item().id);
    expect(found?.archived).toBe(false);
  });
});

/* ── Variants (migration 0063) ─────────────────────────────────────────────── */

describe("parseMediaVariants / mediaStoragePaths / resolveMediaServeTarget", () => {
  const withVariants = item({
    variants: {
      thumb: { path: "apex/x.thumb.webp", mime: "image/webp", bytes: 100, width: 400, height: 300 },
      card: { path: "apex/x.card.webp", mime: "image/webp", bytes: 900, width: 800, height: 600 },
    },
  });

  it("parses valid variants and drops malformed entries", () => {
    expect(parseMediaVariants(withVariants.variants)).toEqual(withVariants.variants);
    expect(parseMediaVariants(null)).toEqual({});
    expect(parseMediaVariants("nope")).toEqual({});
    expect(parseMediaVariants([1, 2])).toEqual({});
    expect(parseMediaVariants({ thumb: { nope: true }, evil: { path: "x" }, card: { path: "apex/c.webp" } }))
      .toEqual({ card: { path: "apex/c.webp", mime: "image/webp", bytes: null, width: null, height: null } });
  });

  it("lists original + variant paths for deletion", () => {
    expect(mediaStoragePaths(withVariants)).toEqual(["apex/abc.png", "apex/x.thumb.webp", "apex/x.card.webp"]);
    expect(mediaStoragePaths(item())).toEqual(["apex/abc.png"]);
  });

  it("resolves original/variant targets and rejects unknown names", () => {
    expect(resolveMediaServeTarget(withVariants, null)).toEqual({ path: "apex/abc.png", mime: "image/png" });
    expect(resolveMediaServeTarget(withVariants, "original")).toEqual({ path: "apex/abc.png", mime: "image/png" });
    expect(resolveMediaServeTarget(withVariants, "thumb")).toEqual({ path: "apex/x.thumb.webp", mime: "image/webp" });
    expect(resolveMediaServeTarget(withVariants, "card")?.path).toBe("apex/x.card.webp");
    // known-but-missing variant → null (route redirects to original)
    expect(resolveMediaServeTarget(item(), "thumb")).toBeNull();
    // unknown variant name → null (route 404s)
    expect(resolveMediaServeTarget(withVariants, "huge")).toBeNull();
  });
});

describe("registerMedia with processing metadata", () => {
  it("persists width/height/variants/variant_error", async () => {
    const media = fakeTable();
    const audit = fakeTable();
    const { db } = fakeDb({ site_media: media, system_audit_events: audit });
    stateOf(media).queue.push({ data: item({ width: 800, height: 600, variants: { thumb: { path: "apex/x.thumb.webp", mime: "image/webp", bytes: 1, width: 400, height: 300 } } }), error: null });
    const res = await registerMedia(db, actor, {
      siteKey: "apex", storagePath: "apex/x.png", mime: "image/png", bytes: 10,
      altText: "Alt", category: "general",
      width: 800, height: 600,
      variants: { thumb: { path: "apex/x.thumb.webp", mime: "image/webp", bytes: 1, width: 400, height: 300 } },
      variantError: null,
    });
    expect(res.ok).toBe(true);
    const ins = stateOf(media).inserted[0] as Record<string, unknown>;
    expect(ins.width).toBe(800);
    expect(ins.height).toBe(600);
    expect(ins.variants).toMatchObject({ thumb: { path: "apex/x.thumb.webp" } });
    expect(ins.variant_error).toBeNull();
  });
});

describe("deleteMedia removes variants too", () => {
  it("storage remove receives original + all variant paths", async () => {
    const media = fakeTable();
    const content = fakeTable();
    const { db, removed } = fakeDb({ site_media: media, site_content: content });
    const m = item({
      variants: {
        thumb: { path: "apex/x.thumb.webp", mime: "image/webp", bytes: 1, width: 400, height: 300 },
        card: { path: "apex/x.card.webp", mime: "image/webp", bytes: 2, width: 800, height: 600 },
      },
    });
    stateOf(media).queue.push({ data: m, error: null });
    stateOf(content).queue.push({ data: [], error: null });
    const res = await deleteMedia(db, actor, "apex", m.id);
    expect(res.ok).toBe(true);
    expect(removed).toEqual([["apex/abc.png", "apex/x.thumb.webp", "apex/x.card.webp"]]);
    expect(stateOf(media).deleted).toHaveLength(1);
  });
});
