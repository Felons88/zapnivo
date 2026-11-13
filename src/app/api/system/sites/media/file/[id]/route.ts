import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";
import { getMediaById, MEDIA_MIMES } from "@/lib/system/site-media";

/**
 * GET /api/system/sites/media/file/[id] — PUBLIC image serve route.
 *
 * Deliberately NOT behind systemApiGuard: CMS media is published content meant
 * to render on public pages. Access control comes from unguessable uuid ids +
 * the private 'site-media' bucket (service-role only). Serving same-origin keeps
 * the site CSP (img-src 'self') intact and lets next/image optimize these URLs.
 * Archived items still serve — published content may legitimately reference
 * them; only hard delete removes the bytes.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });

  const db = serviceClient();
  if (!db) return new NextResponse("Backend not configured", { status: 503 });

  const item = await getMediaById(db, id);
  if (!item || !item.storage_bucket || !item.mime || !(MEDIA_MIMES as readonly string[]).includes(item.mime)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { data, error } = await db.storage.from(item.storage_bucket).download(item.path);
  if (error || !data) return new NextResponse("Not found", { status: 404 });

  const buf = Buffer.from(await data.arrayBuffer());
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": item.mime,
      "content-length": String(buf.length),
      // Immutable: media ids are uuids — a new upload always gets a new URL.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
