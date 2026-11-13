import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";
import { getMediaById, MEDIA_MIMES, resolveMediaServeTarget, sniffImageMime } from "@/lib/system/site-media";

/**
 * GET /api/system/sites/media/file/[id]?variant=thumb|card|original — PUBLIC
 * image serve route.
 *
 * Deliberately NOT behind systemApiGuard: CMS media is published content meant
 * to render on public pages. Access control comes from unguessable uuid ids +
 * the private 'site-media' bucket (service-role only). Serving same-origin keeps
 * the site CSP (img-src 'self') intact and lets next/image optimize these URLs.
 * Archived items still serve — published content may legitimately reference
 * them; only hard delete removes the bytes.
 *
 * ?variant= selects a generated derivative (webp thumb/card). A missing
 * variant redirects to the original rather than 404ing — content may reference
 * variants before they finish generating, and the original is always valid.
 * Unknown variant names 404. Content-Type is sniffed from the actual bytes,
 * never trusted from stored metadata.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });

  const url = new URL(req.url);
  const variant = url.searchParams.get("variant");

  const db = serviceClient();
  if (!db) return new NextResponse("Backend not configured", { status: 503 });

  const item = await getMediaById(db, id);
  if (!item || !item.storage_bucket || !item.mime || !(MEDIA_MIMES as readonly string[]).includes(item.mime)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const target = resolveMediaServeTarget(item, variant);
  if (!target) {
    if (variant === "thumb" || variant === "card") {
      // Known variant that hasn't been generated (processing failed or the
      // upload predates variants) → fall back to the original, honestly.
      const fallback = new URL(req.url);
      fallback.searchParams.delete("variant");
      return NextResponse.redirect(fallback, 302);
    }
    return new NextResponse("Not found", { status: 404 }); // unknown variant name
  }

  const { data, error } = await db.storage.from(item.storage_bucket).download(target.path);
  if (error || !data) return new NextResponse("Not found", { status: 404 });

  const buf = Buffer.from(await data.arrayBuffer());
  // Sniff the real bytes — stored mime is metadata, not truth.
  const mime = sniffImageMime(new Uint8Array(buf)) ?? target.mime ?? "application/octet-stream";
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(buf.length),
      // Immutable: media ids are uuids — a new upload always gets a new URL.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
