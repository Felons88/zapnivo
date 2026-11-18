import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { deletionAnonymization } from "@/lib/customer-privacy";
import { isResponse, mobileCustomer, type MobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";
import { normalizePhone, sendSms } from "@/lib/sms";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notify_sms: z.boolean().optional(),
  phone: z.string().trim().min(7).max(20).optional(),
  otp: z.string().trim().min(4).max(8).optional(),
  email: z.string().trim().email().max(254).optional(),
}).refine((v) => v.name !== undefined || v.notify_sms !== undefined || v.phone !== undefined || v.email !== undefined);

const hash = (s: string) => createHash("sha256").update(`phone-otp:${s}`).digest("hex");

/** Sends a fresh 6-digit SMS code proving control of the new number. */
async function issuePhoneOtp(c: MobileCustomer, phone: string) {
  await c.db.from("phone_change_otps").update({ consumed_at: new Date().toISOString() }).eq("profile_id", c.user.id).is("consumed_at", null);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const { error } = await c.db.from("phone_change_otps").insert({ profile_id: c.user.id, phone, code_hash: hash(code), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
  if (error) return NextResponse.json({ error: "We couldn't start the verification." }, { status: 503 });
  const res = await sendSms(c.db, { to: phone, body: `Your Zapnivo verification code is ${code}. It expires in 10 minutes.`, kind: "phone_change" });
  if (!res.sent) return NextResponse.json({ error: "We couldn't text that number. Check it and try again." }, { status: 502 });
  return NextResponse.json({ ok: true, phone_otp: "sent" }, { headers: noStore });
}

/** Verifies the code, then commits the new number. */
async function confirmPhoneOtp(c: MobileCustomer, phone: string, otp: string) {
  const { data } = await c.db.from("phone_change_otps").select("id,code_hash,expires_at,attempts")
    .eq("profile_id", c.user.id).eq("phone", phone).is("consumed_at", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const row = data as { id: string; code_hash: string; expires_at: string; attempts: number } | null;
  if (!row || new Date(row.expires_at) < new Date() || row.attempts >= 5) {
    return NextResponse.json({ error: "That code expired. Request a new one." }, { status: 422 });
  }
  if (row.code_hash !== hash(otp)) {
    await c.db.from("phone_change_otps").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return NextResponse.json({ error: "That code isn't right. Check the text and try again." }, { status: 422 });
  }
  await c.db.from("phone_change_otps").update({ consumed_at: new Date().toISOString() }).eq("id", row.id);
  const { error } = await c.db.from("profiles").update({ phone }).eq("id", c.user.id);
  if (error) return NextResponse.json({ error: "We couldn't save the new number." }, { status: 503 });
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const { data, error } = await c.db.from("profiles").select("full_name,phone,email,notify_sms").eq("id", c.user.id).maybeSingle();
  if (error || !data) {
    // notify_sms comes from the privacy migration; fall back so the account still loads without it.
    const base = await c.db.from("profiles").select("full_name,phone,email").eq("id", c.user.id).maybeSingle();
    if (base.error || !base.data) return NextResponse.json({ error: "Account service unavailable." }, { status: 503 });
    const b = base.data as { full_name: string | null; phone: string | null; email: string | null };
    return NextResponse.json({ id: c.user.id, name: b.full_name, phone: b.phone, email: b.email?.endsWith("@mobile.zapnivo.com") ? null : b.email, notify_sms: false }, { headers: noStore });
  }
  const d = data as { full_name: string | null; phone: string | null; email: string | null; notify_sms: boolean | null };
  return NextResponse.json({
    id: c.user.id, name: d.full_name, phone: d.phone,
    email: d.email?.endsWith("@mobile.zapnivo.com") ? null : d.email, notify_sms: d.notify_sms ?? false,
  }, { headers: noStore });
}

export async function PATCH(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-me:${c.user.id}`, 20, 10 * 60_000).ok) return NextResponse.json({ error: "Too many changes. Try again later." }, { status: 429 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Check what you're changing — a name, phone or email is required." }, { status: 422 });

  // Phone changes are two-step: PATCH {phone} texts a code, PATCH {phone, otp} commits it.
  if (parsed.data.phone) {
    const phone = normalizePhone(parsed.data.phone);
    if (!phone) return NextResponse.json({ error: "Enter a valid mobile number." }, { status: 422 });
    return parsed.data.otp ? confirmPhoneOtp(c, phone, parsed.data.otp) : issuePhoneOtp(c, phone);
  }

  // Email changes go through Supabase's own confirmation — a verify link is sent to
  // the NEW address; the sign-in email only moves after they click it.
  if (parsed.data.email) {
    const token = req.headers.get("authorization")?.replace(/^bearer /i, "");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!token || !url || !anon) return NextResponse.json({ error: "Service unavailable." }, { status: 503 });
    const userClient = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { error } = await userClient.auth.updateUser({ email: parsed.data.email.toLowerCase() });
    if (error) return NextResponse.json({ error: error.message.slice(0, 140) }, { status: 422 });
    return NextResponse.json({ ok: true, email: "verification_sent" }, { headers: noStore });
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) update.full_name = parsed.data.name;
  if (parsed.data.notify_sms !== undefined) update.notify_sms = parsed.data.notify_sms;
  const { error } = await c.db.from("profiles").update(update).eq("id", c.user.id);
  if (error) return NextResponse.json({ error: "We couldn't save that change." }, { status: 503 });
  return NextResponse.json({ ok: true });
}

/** Account deletion request (same queue + PII minimization as the website). */
export async function DELETE(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-delete:${c.user.id}`, 3, 60 * 60_000).ok) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  const { data: existing } = await c.db.from("customer_data_requests").select("id").eq("kind", "deletion").eq("email", c.email).eq("status", "pending").limit(1);
  if (existing?.length) return NextResponse.json({ ok: true, status: "pending", duplicate: true });
  const { error } = await c.db.from("customer_data_requests").insert({
    user_id: c.user.id, email: c.email, kind: "deletion", status: "pending",
    note: "Customer requested account deletion from the mobile app. Financial records retained per retention policy.",
  });
  if (error) return NextResponse.json({ error: "We couldn't record your request. Please contact support in the app." }, { status: 503 });
  await c.db.from("profiles").update(deletionAnonymization).eq("id", c.user.id);
  return NextResponse.json({ ok: true, status: "pending" });
}
