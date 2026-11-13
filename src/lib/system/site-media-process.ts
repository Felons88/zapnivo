import type { MediaMime } from "./site-media";

/**
 * Website Management Center — media image processing (Phase 3.2).
 *
 * Pure/server-side helpers for the site-media pipeline:
 *  - header-only dimension sniffing (NO pixel decode — safe to run on hostile
 *    input before any decoder sees it);
 *  - decompression-bomb limits (max pixels / max edge);
 *  - variant generation via sharp (thumb + card webp, EXIF stripped by
 *    re-encode). sharp is a production dep of this repo (Next image
 *    optimization), so real processing is used — nothing is faked.
 *
 * Everything here is bounded: input is already capped at 5 MB and 50 MP by
 * the callers, and sharp's own limitInputPixels is set as a second gate.
 */

export const MEDIA_MAX_PIXELS = 50_000_000; // 50 megapixels decoded
export const MEDIA_MAX_DIMENSION = 12_000; // max width or height in px

export type ImageDims = { width: number; height: number };

export type DimsCheck =
  | { ok: true; width: number | null; height: number | null }
  | { ok: false; error: string };

/* ── Header-only dimension sniffing (pure — unit tested) ───────────────────── */

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) =>
  ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0;

function pngDims(b: Uint8Array): ImageDims | null {
  // IHDR is always the first chunk: 8-byte sig, 4-byte len, "IHDR", then w/h.
  if (b.length < 24 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function gifDims(b: Uint8Array): ImageDims | null {
  // Logical Screen Descriptor: u16le width/height right after the 6-byte header.
  if (b.length < 10) return null;
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** SOF markers that carry dimensions (excludes DHT C4, JPG C8, DAC CC, RSTn). */
const isSof = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegDims(b: Uint8Array): ImageDims | null {
  // Walk JPEG segments until a Start-Of-Frame marker. All lengths are u16be
  // and include the 2 length bytes themselves.
  let p = 2; // skip FFD8
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) { p += 1; continue; }
    // skip fill bytes
    while (p < b.length && b[p] === 0xff) p += 1;
    if (p >= b.length) return null;
    const marker = b[p];
    p += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone
    if (p + 2 > b.length) return null;
    const segLen = u16be(b, p);
    if (segLen < 2 || p + segLen > b.length) return null;
    if (isSof(marker) && segLen >= 7) {
      // segLen covers len(2)+precision(1)+height(2)+width(2)+components(1)+…
      const height = u16be(b, p + 3);
      const width = u16be(b, p + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    p += segLen;
  }
  return null;
}

function webpDims(b: Uint8Array): ImageDims | null {
  // RIFF(12) → chunk fourcc at 12-15, u32le size at 16-19, data at 20+.
  if (b.length < 25 || b[12] !== 0x56 || b[13] !== 0x50 || b[14] !== 0x38) return null; // "VP8"
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  const d = 20; // chunk payload start
  if (fourcc === "VP8X" && b.length >= d + 10) {
    // Canvas width/height stored as (value - 1) in 24-bit LE after 4 flag bytes.
    const width = u24le(b, d + 4) + 1;
    const height = u24le(b, d + 7) + 1;
    return { width, height };
  }
  if (fourcc === "VP8L" && b.length >= d + 5) {
    // Signature byte 0x2F then 14-bit (w-1)/(h-1) packed little-endian.
    if (b[d] !== 0x2f) return null;
    const bits = b[d + 1] | (b[d + 2] << 8) | (b[d + 3] << 16) | (b[d + 4] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (fourcc === "VP8 " && b.length >= d + 10) {
    // Lossy bitstream: 3-byte frame tag, then 9D 01 2A start code, then dims.
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null;
    const width = u16le(b, d + 6) & 0x3fff;
    const height = u16le(b, d + 8) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/**
 * Reads intrinsic dimensions from the file header WITHOUT decoding pixels.
 * Returns null when dims can't be determined cheaply — AVIF (ISO-BMFF `ispe`
 * boxes live inside `meta`/`iprp` and a naive scan can false-positive on
 * compressed payloads, so we honestly skip it) and truncated/corrupt files.
 * Callers must treat null dims as "unknown" and rely on the decoder-side
 * limits (sharp limitInputPixels + post-metadata bounds check) instead.
 */
export function sniffImageDimensions(bytes: Uint8Array, mime: MediaMime): ImageDims | null {
  switch (mime) {
    case "image/png": return pngDims(bytes);
    case "image/gif": return gifDims(bytes);
    case "image/jpeg": return jpegDims(bytes);
    case "image/webp": return webpDims(bytes);
    case "image/avif": return null; // honest skip — see docstring
    default: return null;
  }
}

/** Enforces the decompression-bomb ceilings on a known dimension pair. */
export function checkImageBounds(dims: ImageDims): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(dims.width) || !Number.isFinite(dims.height) || dims.width <= 0 || dims.height <= 0) {
    return { ok: false, error: "Image has invalid dimensions" };
  }
  if (dims.width > MEDIA_MAX_DIMENSION || dims.height > MEDIA_MAX_DIMENSION) {
    return { ok: false, error: `Image too large — max ${MEDIA_MAX_DIMENSION}px per side` };
  }
  if (dims.width * dims.height > MEDIA_MAX_PIXELS) {
    return { ok: false, error: `Image too large — max ${Math.floor(MEDIA_MAX_PIXELS / 1_000_000)} megapixels` };
  }
  return { ok: true };
}

/**
 * Upload-time gate: sniffs dimensions and rejects known bombs BEFORE any
 * decoder runs. Unknown dims (avif, corrupt headers) pass through — the
 * decoder-side check in generateMediaVariants is the backstop.
 */
export function inspectMediaUpload(mime: MediaMime, bytes: Uint8Array): DimsCheck {
  const dims = sniffImageDimensions(bytes, mime);
  if (!dims) return { ok: true, width: null, height: null };
  const bounds = checkImageBounds(dims);
  if (!bounds.ok) return bounds;
  return { ok: true, width: dims.width, height: dims.height };
}

/* ── Variant generation (sharp) ────────────────────────────────────────────── */

export const MEDIA_VARIANT_NAMES = ["thumb", "card"] as const;
export type MediaVariantName = (typeof MEDIA_VARIANT_NAMES)[number];
export const isMediaVariantName = (v: unknown): v is MediaVariantName =>
  typeof v === "string" && (MEDIA_VARIANT_NAMES as readonly string[]).includes(v);

/** thumb ≈ grid tile, card ≈ content/hero slot. Both webp, never enlarged. */
export const MEDIA_VARIANTS: Record<MediaVariantName, { width: number; quality: number }> = {
  thumb: { width: 400, quality: 78 },
  card: { width: 1200, quality: 80 },
};

export const VARIANT_MIME = "image/webp" as const;

/** Storage path for a variant: `site/<uuid>.<ext>` → `site/<uuid>.<name>.webp`. */
export function mediaVariantPath(storagePath: string, name: MediaVariantName): string {
  const base = storagePath.replace(/\.[^.]+$/, "");
  return `${base}.${name}.webp`;
}

export type GeneratedVariant = { data: Buffer; width: number; height: number };
export type VariantResult =
  | { ok: true; width: number | null; height: number | null; variants: Record<MediaVariantName, GeneratedVariant> }
  | { ok: false; error: string };

/**
 * Generates thumb + card webp variants from the ORIGINAL bytes.
 * Never throws — returns { ok:false, error } so callers can store the
 * original and record variant_error honestly instead of failing the upload.
 *
 * sharp is imported lazily so this module stays importable in environments
 * without the native binary (tests mock it); the route always runs where
 * sharp is installed.
 */
export async function generateMediaVariants(bytes: Uint8Array, mime: MediaMime): Promise<VariantResult> {
  try {
    const { default: sharp } = await import("sharp");
    // limitInputPixels is the decoder-side bomb gate (per-frame for animated
    // input; pages:1 keeps us on the first frame only). failOn:"error" makes
    // truncated/corrupt files throw instead of silently producing partials.
    const img = sharp(Buffer.from(bytes), {
      limitInputPixels: MEDIA_MAX_PIXELS,
      failOn: "error",
      pages: 1,
    });
    const meta = await img.metadata();
    const width = typeof meta.width === "number" ? meta.width : null;
    const height = typeof meta.height === "number" ? meta.height : null;
    if (width !== null && height !== null) {
      const bounds = checkImageBounds({ width, height });
      if (!bounds.ok) return { ok: false, error: bounds.error };
    }

    const variants = {} as Record<MediaVariantName, GeneratedVariant>;
    for (const name of MEDIA_VARIANT_NAMES) {
      const spec = MEDIA_VARIANTS[name];
      // .rotate() auto-orients from EXIF then the webp re-encode drops all
      // metadata (EXIF/XMP/ICC unless explicitly kept) — variants are clean.
      const out = await img
        .clone()
        .rotate()
        .resize({ width: spec.width, withoutEnlargement: true })
        .webp({ quality: spec.quality })
        .toBuffer({ resolveWithObject: true });
      variants[name] = { data: out.data, width: out.info.width, height: out.info.height };
    }
    return { ok: true, width, height, variants };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `variant generation failed: ${msg}`.slice(0, 300) };
  }
}
