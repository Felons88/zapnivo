import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

const TYPES: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };
const MAX = 8 * 1024 * 1024;

/** Partner uploads a requested document. Strictly scoped to the caller's own organization. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  const back = (result: string, detail?: string) => {
    const url = new URL("/partners/documents", req.url);
    url.searchParams.set("result", result);
    if (detail) url.searchParams.set("detail", detail);
    return NextResponse.redirect(url, 303);
  };
  if (!user || user.role !== "partner" || !user.organizationId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const id = String(form.get("request_id") ?? "");
  const file = form.get("file");
  if (!z.string().uuid().safeParse(id).success || !(file instanceof File) || file.size === 0) return back("error", "Choose a file to upload.");
  const ext = TYPES[file.type];
  if (!ext) return back("error", "Only PDF, JPEG or PNG files are accepted.");
  if (file.size > MAX) return back("error", "Files must be 8 MB or smaller.");

  const orgId = user.organizationId;
  const { data: reqRow } = await db.from("partner_document_requests").select("id,status").eq("id", id).eq("organization_id", orgId).maybeSingle();
  if (!reqRow) return back("error", "That request was not found.");
  if (reqRow.status === "waived") return back("error", "That request was waived.");

  const path = `${orgId}/${id}-${Date.now()}.${ext}`;
  const { error: upErr } = await db.storage.from("partner-documents").upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type });
  if (upErr) return back("error", "The upload failed. Please try again.");
  const { error } = await db.from("partner_document_requests").update({ status: "received", storage_path: path, received_at: new Date().toISOString() }).eq("id", id).eq("organization_id", orgId);
  if (error) {
    await db.storage.from("partner-documents").remove([path]);
    return back("error", "The document could not be recorded.");
  }
  await auditLog(user.id, "partner_upload_document", "partner_document_request", id, { organization_id: orgId, type: file.type, bytes: file.size });
  return back("uploaded");
}
