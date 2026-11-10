import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { deletionAnonymization } from "@/lib/customer-privacy";
import { clientIp, fail, sameOrigin } from "@/lib/helpdesk/http";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ confirm: z.literal(true) });

/**
 * Account deletion REQUEST. We can't hard-delete immediately: rentals, payments and refunds are
 * financial records retained for legal/tax purposes, and the auth user must be removed by an admin.
 * What we do now: record the request in customer_data_requests (admin queue) and strip the
 * immediately-removable PII on the profile (full_name, phone). Email is kept until an admin
 * completes the deletion so the request can be actioned and confirmed.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const user = await getSessionUser();
  if (!user) return fail(401, "Please sign in.");
  if (user.role !== "customer") return fail(403, "This request is for customer accounts.");
  if (!rateLimit(`account-delete:${user.id}:${clientIp(req)}`, 3, 60 * 60_000).ok) {
    return fail(429, "Too many requests. Please try again later.");
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, "Please confirm the deletion request.");

  const db = serviceClient();
  if (!db) return fail(503, "Account deletion requests aren't available yet.", { code: "backend_unconfigured" });

  const uid = /^[0-9a-f-]{36}$/i.test(user.id) ? user.id : null;

  // One open request at a time.
  const { data: existing } = await db
    .from("customer_data_requests")
    .select("id,status,created_at")
    .eq("kind", "deletion")
    .eq("email", user.email)
    .eq("status", "pending")
    .limit(1);
  if (existing?.length) {
    return NextResponse.json({ ok: true, status: "pending", duplicate: true });
  }

  const { error: insErr } = await db.from("customer_data_requests").insert({
    user_id: uid,
    email: user.email,
    kind: "deletion",
    status: "pending",
    note: "Customer requested account deletion. Financial records retained per retention policy; remove auth user and remaining PII.",
  });
  if (insErr) {
    console.error(JSON.stringify({ level: "error", scope: "account-delete", msg: insErr.message }));
    return fail(503, "We couldn't record your request yet — please email privacy@zapnivo.com.", { code: "backend_unconfigured" });
  }

  // Immediate PII minimization on the profile (best-effort; request is already queued either way).
  let anonymized = false;
  if (uid) {
    const { error } = await db.from("profiles").update(deletionAnonymization).eq("id", uid);
    anonymized = !error;
    if (error) console.error(JSON.stringify({ level: "error", scope: "account-delete-anonymize", msg: error.message }));
  }

  return NextResponse.json({ ok: true, status: "pending", anonymized });
}
