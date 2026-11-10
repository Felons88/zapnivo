import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ id: z.string().uuid(), action: z.enum(["complete", "cancel"]) });

/** Staff queue for customer data requests (export/deletion). Deletion completion removes the auth user. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const ct = req.headers.get("content-type") ?? "";
  const isForm = !ct.includes("application/json");
  const raw = isForm ? Object.fromEntries(await req.formData().catch(() => new FormData())) : await req.json().catch(() => null);
  const p = schema.safeParse(raw);
  const done = (result: string, status = 200) => isForm
    ? NextResponse.redirect(new URL(`/admin/users?result=${result}`, req.url), 303)
    : NextResponse.json({ ok: result === "ok" }, { status });
  if (!p.success) return done("error", 422);

  const { data: reqRow } = await db.from("customer_data_requests").select("id,user_id,email,kind,status").eq("id", p.data.id).maybeSingle();
  if (!reqRow) return done("error", 404);
  if (reqRow.status !== "pending") return done("error", 409);

  if (p.data.action === "cancel") {
    await db.from("customer_data_requests").update({ status: "cancelled", processed_at: new Date().toISOString(), processed_by: user!.id }).eq("id", reqRow.id);
    await auditLog(user!.id, "privacy_request_cancel", "customer_data_request", reqRow.id, { kind: reqRow.kind });
    return done("ok");
  }

  // Complete: for deletions, remove the auth user (PII was already anonymized at request time).
  // Financial rows (rentals/payments/refunds) are retained for legal/tax retention.
  if (reqRow.kind === "deletion" && reqRow.user_id) {
    const { error: delErr } = await db.auth.admin.deleteUser(reqRow.user_id);
    if (delErr) return done("error", 502);
  }
  await db.from("customer_data_requests").update({ status: "processed", processed_at: new Date().toISOString(), processed_by: user!.id }).eq("id", reqRow.id);
  await auditLog(user!.id, "privacy_request_complete", "customer_data_request", reqRow.id, { kind: reqRow.kind, email: reqRow.email });
  return done("ok");
}
