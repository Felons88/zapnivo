import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  MEDIA_MAX_DIMENSION, MEDIA_MAX_PIXELS, MEDIA_VARIANT_NAMES, MEDIA_VARIANTS,
  VARIANT_MIME, checkImageBounds, generateMediaVariants, inspectMediaUpload,
  isMediaVariantName, mediaVariantPath, sniffImageDimensions,
} from "@/lib/system/site-media-process";
import type { MediaMime } from "@/lib/system/site-media";

/* ── Header fixtures (hand-built — no decoder involved) ───────────────────── */

const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

/** Minimal PNG: sig + IHDR(len,type,w,h,bitdepth,colortype,…) — dims only. */
function pngHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ...u32be(width), ...u32be(height),
    8, 6, 0, 0, 0, // bit depth, colour type, compression, filter, interlace
  ]);
}

/** Minimal JPEG: FFD8 + APP0 + SOF0 carrying width/height. */
function jpegWithSof(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, // APP0
    0xff, 0xc0, 0, 17, 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0,
  ]);
}

function gifHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16le(width), ...u16le(height), 0, 0, 0,
  ]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  // RIFF size WEBP VP8X chunk(10 bytes data: flags+3res+3w-1+3h-1)
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0,
    0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1),
  ]);
}

function webpVp8l(width: number, height: number): Uint8Array {
  const w1 = width - 1, h1 = height - 1;
  const bits = (w1 & 0x3fff) | ((h1 & 0x3fff) << 14);
  const b0 = bits & 0xff, b1 = (bits >> 8) & 0xff, b2 = (bits >> 16) & 0xff, b3 = (bits >> 24) & 0xff;
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f, b0, b1, b2, b3,
  ]);
}

function webpVp8(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20, 10, 0, 0, 0,
    0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height),
  ]);
}

const AVIF = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);

/* ── Dimension sniffing ────────────────────────────────────────────────────── */

describe("sniffImageDimensions", () => {
  it("reads PNG IHDR", () => {
    expect(sniffImageDimensions(pngHeader(1920, 1080), "image/png")).toEqual({ width: 1920, height: 1080 });
  });
  it("reads GIF logical screen descriptor", () => {
    expect(sniffImageDimensions(gifHeader(320, 200), "image/gif")).toEqual({ width: 320, height: 200 });
  });
  it("reads JPEG SOF0 after APP segments", () => {
    expect(sniffImageDimensions(jpegWithSof(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
  });
  it("reads all three WebP chunk variants", () => {
    expect(sniffImageDimensions(webpVp8x(1000, 500), "image/webp")).toEqual({ width: 1000, height: 500 });
    expect(sniffImageDimensions(webpVp8l(333, 222), "image/webp")).toEqual({ width: 333, height: 222 });
    expect(sniffImageDimensions(webpVp8(777, 111), "image/webp")).toEqual({ width: 777, height: 111 });
  });
  it("honestly returns null for AVIF and corrupt/truncated files", () => {
    expect(sniffImageDimensions(AVIF, "image/avif")).toBeNull();
    expect(sniffImageDimensions(pngHeader(10, 10).subarray(0, 20), "image/png")).toBeNull();
    expect(sniffImageDimensions(new Uint8Array(4), "image/png")).toBeNull();
    // zero dims are rejected
    expect(sniffImageDimensions(pngHeader(0, 100), "image/png")).toBeNull();
  });
});

/* ── Bomb protection ───────────────────────────────────────────────────────── */

describe("checkImageBounds / inspectMediaUpload", () => {
  it("accepts normal sizes", () => {
    expect(checkImageBounds({ width: 4000, height: 3000 })).toEqual({ ok: true }); // 12MP
    const r = inspectMediaUpload("image/png", pngHeader(1920, 1080));
    expect(r).toEqual({ ok: true, width: 1920, height: 1080 });
  });
  it("rejects edges over the max dimension", () => {
    const r = inspectMediaUpload("image/png", pngHeader(MEDIA_MAX_DIMENSION + 1, 100));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("per side");
  });
  it("rejects pixel counts over 50MP even when each edge is legal", () => {
    const r = inspectMediaUpload("image/png", pngHeader(8000, 8000)); // 64MP
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("megapixels");
    expect(inspectMediaUpload("image/png", pngHeader(7000, 7000)).ok).toBe(true); // 49MP
    expect(MEDIA_MAX_PIXELS).toBe(50_000_000);
  });
  it("passes unknown dims through (avif) for the decoder-side gate", () => {
    const r = inspectMediaUpload("image/avif", AVIF);
    expect(r).toEqual({ ok: true, width: null, height: null });
  });
});

/* ── Variant generation (real sharp, tiny fixtures) ────────────────────────── */

const makePng = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();

const isWebp = (b: Buffer) =>
  b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";

describe("generateMediaVariants", () => {
  it("generates thumb + card webp variants within bounds", async () => {
    const src = await makePng(800, 600);
    const res = await generateMediaVariants(new Uint8Array(src), "image/png");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.width).toBe(800);
    expect(res.height).toBe(600);
    expect(Object.keys(res.variants).sort()).toEqual([...MEDIA_VARIANT_NAMES].sort());
    const thumb = res.variants.thumb;
    const card = res.variants.card;
    expect(isWebp(thumb.data)).toBe(true);
    expect(isWebp(card.data)).toBe(true);
    expect(thumb.width).toBe(400); // 800 → 400
    expect(thumb.height).toBe(300);
    // withoutEnlargement: 800px source stays 800 for the 1200px card spec
    expect(card.width).toBe(800);
    expect(card.height).toBe(600);
    // and the buffers really are webp per sharp's own metadata
    const meta = await sharp(thumb.data).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(400);
  });

  it("does not enlarge small images", async () => {
    const src = await makePng(100, 50);
    const res = await generateMediaVariants(new Uint8Array(src), "image/png");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.variants.thumb.width).toBe(100);
    expect(res.variants.card.width).toBe(100);
  });

  it("strips EXIF/metadata from variants (re-encode)", async () => {
    // JPEG carrying EXIF orientation=6 (rotate 90°) — variant must be clean webp.
    const withExif = await sharp(await makePng(200, 100))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const srcMeta = await sharp(withExif).metadata();
    expect(srcMeta.orientation).toBe(6);
    expect(srcMeta.exif).toBeDefined();

    const res = await generateMediaVariants(new Uint8Array(withExif), "image/jpeg");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const meta = await sharp(res.variants.thumb.data).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    // .rotate() baked the orientation in: 200x100 @ orient 6 → 100x200 portrait,
    // and withoutEnlargement keeps it at 100px wide for the 400px thumb spec.
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
  });

  it("fails honestly on undecodable input (no fake variants)", async () => {
    const res = await generateMediaVariants(new Uint8Array([1, 2, 3, 4, 5]), "image/png");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("variant generation failed");
  });

  it("fails honestly on decompression bombs caught by the decoder", async () => {
    // Valid PNG header claiming 60MP but no real pixel data — sharp must throw,
    // and the sniffer would have rejected it earlier anyway.
    const bomb = pngHeader(9000, 9000); // 81MP > 50MP cap
    expect(inspectMediaUpload("image/png", bomb).ok).toBe(false);
    const res = await generateMediaVariants(bomb, "image/png");
    expect(res.ok).toBe(false);
  });
});

/* ── Helpers ───────────────────────────────────────────────────────────────── */

describe("variant helpers", () => {
  it("mediaVariantPath derives sibling webp paths", () => {
    expect(mediaVariantPath("apex/abc.png", "thumb")).toBe("apex/abc.thumb.webp");
    expect(mediaVariantPath("apex/abc.jpeg", "card")).toBe("apex/abc.card.webp");
  });
  it("isMediaVariantName guards the variant param", () => {
    expect(isMediaVariantName("thumb")).toBe(true);
    expect(isMediaVariantName("card")).toBe(true);
    expect(isMediaVariantName("original")).toBe(false);
    expect(isMediaVariantName("huge")).toBe(false);
    expect(isMediaVariantName(42)).toBe(false);
  });
  it("variant specs are sane", () => {
    expect(MEDIA_VARIANTS.thumb.width).toBeLessThan(MEDIA_VARIANTS.card.width);
    expect(VARIANT_MIME).toBe("image/webp");
    const mime: MediaMime = "image/webp";
    expect(mime).toBe("image/webp");
  });
});
