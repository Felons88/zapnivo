import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { DOC_KINDS, isManualStep } from "@/lib/partner-ops";
import { serviceClient } from "@/lib/supabase";

const uuid = z.string().uuid();

/** Staff: download a partner document via a short-lived signed URL (GET ?download=<request id>). */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const id = new URL(req.url).searchParams.get("download") ?? "";
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { data } = await db.from("partner_document_requests").select("storage_path,organization_id").eq("id", id).maybeSingle();
  if (!data?.storage_path) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data: signed, error } = await db.storage.from("partner-documents").createSignedUrl(data.storage_path, 60);
  if (error || !signed) return NextResponse.json({ error: "Could not create link" }, { status: 500 });
  await auditLog(user!.id, "download_partner_document", "partner_document_request", id, { organization_id: data.organization_id });
  return NextResponse.redirect(signed.signedUrl, 303);
}

/** Staff onboarding actions. Feedback via ?result= on /admin/onboarding. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const back = (result: string, detail?: string) => {
    const url = new URL("/admin/onboarding", req.url);
    url.searchParams.set("result", result);
    if (detail) url.searchParams.set("detail", detail);
    return NextResponse.redirect(url, 303);
  };
  const fail = (d: string) => back("error", d);
  const actor = user!.id;
  const profileId = /^[0-9a-f-]{36}$/i.test(actor) ? actor : null;
  const orgId = String(form.get("organization_id") ?? "");
  if (!uuid.safeParse(orgId).success) return fail("Invalid organization.");

  if (action === "set_step") {
    const step = String(form.get("step") ?? "");
    const on = form.get("done") === "yes";
    if (!isManualStep(step)) return fail("Unknown checklist step.");
    const { error } = on
      ? await db.from("partner_onboarding_steps").upsert({ organization_id: orgId, step, completed_by: profileId, completed_at: new Date().toISOString() }, { onConflict: "organization_id,step" })
      : await db.from("partner_onboarding_steps").delete().eq("organization_id", orgId).eq("step", step);
    if (error) return fail("The checklist could not be updated.");
    await auditLog(actor, on ? "onboarding_step_done" : "onboarding_step_undone", "organization", orgId, { step });
    return back("step");
  }

  if (action === "request_document") {
    const kind = String(form.get("kind") ?? "");
    if (!(kind in DOC_KINDS)) return fail("Choose a document type.");
    const note = String(form.get("note") ?? "").trim().slice(0, 500) || null;
    const { data, error } = await db.from("partner_document_requests").insert({ organization_id: orgId, kind, note, requested_by: profileId }).select("id").single();
    if (error || !data) return fail("The request could not be created.");
    await auditLog(actor, "request_partner_document", "organization", orgId, { kind, request_id: data.id });
    return back("requested");
  }

  if (action === "waive_document") {
    const id = String(form.get("request_id") ?? "");
    if (!uuid.safeParse(id).success) return fail("Invalid request.");
    const { data, error } = await db.from("partner_document_requests").update({ status: "waived" }).eq("id", id).eq("organization_id", orgId).eq("status", "requested").select("id").maybeSingle();
    if (error || !data) return fail("Only open requests can be waived.");
    await auditLog(actor, "waive_partner_document", "organization", orgId, { request_id: id });
    return back("waived");
  }

  return fail("Unknown onboarding action.");
}
