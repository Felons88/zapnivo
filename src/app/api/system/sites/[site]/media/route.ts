import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { systemApiGuard } from "../../../_shared";
import { getSiteEntry } from "@/lib/system/site-cms";
import {
  MEDIA_BUCKET, MEDIA_CATEGORIES, extForMediaMime, isMediaCategory, listSiteMedia,
  registerMedia, validateMediaUpload, type MediaCategory,
} from "@/lib/system/site-media";
import { assertApprovedOrRequest } from "@/lib/system/audit";
import { reportError } from "@/lib/observability";

type Params = { params: Promise<{ site: string }> };

/**
 * GET /api/system/sites/[site]/media — list library items.
 * Query: ?category=<cat>&archived=1 (archived hidden by default).
 * Perm: system.dashboard.view.
 */
export async function GET(req: Request, ctx: Params) {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { site } = await ctx.params;
  if (!getSiteEntry(site)) return NextResponse.json({ error: "Unknown site" }, { status: 404 });
  const url = new URL(req.url);
  const category = url.searchParams.get("category") ?? undefined;
  const includeArchived = url.searchParams.get("archived") === "1" || url.searchParams.get("archived") === "true";
  const items = await listSiteMedia(g.db, site, {
    category: category && isMediaCategory(category) ? category : undefined,
    includeArchived,
  });
  return NextResponse.json({ items, categories: MEDIA_CATEGORIES });
}

const MAX_ALT = 300;
const MAX_NAME = 200;

/**
 * POST /api/system/sites/[site]/media — multipart upload.
 * Fields: file (required), alt_text (required), category (optional enum).
 * Perm: system.flags.manage + approved change request for breakglass/high-risk.
 * Validation is magic-byte based — declared MIME/extension must agree with content.
 */
export async function POST(req: Request, ctx: Params) {
  const g = await systemApiGuard("system.flags.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { site } = await ctx.params;
  if (!getSiteEntry(site)) return NextResponse.json({ error: "Unknown site" }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  const altText = typeof form.get("alt_text") === "string" ? String(form.get("alt_text")).trim() : "";
  const categoryRaw = typeof form.get("category") === "string" ? String(form.get("category")).trim() : "";
  const category: MediaCategory = isMediaCategory(categoryRaw) ? categoryRaw : "general";

  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 422 });
  if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 422 });
  if (file.name.length > MAX_NAME || /[<>"'`]/.test(file.name)) {
    return NextResponse.json({ error: "Invalid file name" }, { status: 422 });
  }
  if (altText === "" || altText.length > MAX_ALT) {
    return NextResponse.json({ error: `alt_text is required (max ${MAX_ALT} chars)` }, { status: 422 });
  }

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `sitemedia.upload:${site}`,
    risk: "low",
    justification: `Upload site media for ${site}: ${file.name}`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = validateMediaUpload({ fileName: file.name, declaredMime: file.type, bytes });
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 422 });

  const storagePath = `${site}/${randomUUID()}.${extForMediaMime(check.mime)}`;
  const { error: upErr } = await g.db.storage.from(MEDIA_BUCKET).upload(storagePath, bytes, {
    contentType: check.mime,
    upsert: false,
  });
  if (upErr) {
    reportError(upErr, { route: "/api/system/sites/[site]/media", attrs: { op: "storage_upload" } });
    return NextResponse.json({ error: "Couldn't store the file — is the 'site-media' bucket provisioned?" }, { status: 500 });
  }

  const result = await registerMedia(g.db, actor, {
    siteKey: site,
    storagePath,
    mime: check.mime,
    bytes: check.bytes,
    altText,
    category,
  });
  if (!result.ok) {
    // Roll back the orphaned storage object — never leave unregistered bytes.
    await g.db.storage.from(MEDIA_BUCKET).remove([storagePath]).catch(() => {});
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ item: result.data }, { status: 201 });
}

