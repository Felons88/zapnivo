import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { normalizePhone, sendSms, smsConfigured } from "@/lib/sms";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ phone: z.string().min(8).max(20), body: z.string().trim().min(1).max(480) });

/** Staff reply to an existing inbound SMS contact. No arbitrary outbound campaigns. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db || !smsConfigured()) return NextResponse.json({ error: "Phone messaging is not connected." }, { status: 503 });
  const form = await req.formData();
  const parsed = schema.safeParse({ phone: form.get("phone"), body: form.get("body") });
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid phone number and message." }, { status: 422 });
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return NextResponse.json({ error: "Enter a valid phone number and message." }, { status: 422 });
  const { data: inbound, error } = await db.from("sms_messages").select("id").eq("direction", "inbound").eq("from_number", phone).limit(1);
  if (error || !inbound?.length) return NextResponse.json({ error: "Reply requires an existing inbound text." }, { status: 403 });
  const { data: optOut, error: optOutError } = await db.from("sms_opt_outs").select("phone").eq("phone", phone).maybeSingle();
  if (optOutError) return NextResponse.json({ error: "Consent status is unavailable. Nothing was sent." }, { status: 503 });
  if (optOut) return NextResponse.json({ error: "This contact opted out of texts." }, { status: 403 });
  if (!rateLimit("receptionist-sms:" + user!.id, 12, 60 * 60_000).ok) return NextResponse.json({ error: "Too many replies. Try again later." }, { status: 429 });
  const sent = await sendSms(db, { to: phone, body: parsed.data.body });
  await auditLog(user!.id, "receptionist_sms_reply", "sms_message", inbound[0].id, { sent: sent.sent, reason: sent.reason ?? null });
  const url = new URL("/admin/receptionist", req.url);
  url.searchParams.set("channel", "phone");
  url.searchParams.set("phone", phone);
  url.searchParams.set("result", sent.sent ? "sent" : sent.reason === "opted_out" ? "opted_out" : "failed");
  return NextResponse.redirect(url, 303);
}
