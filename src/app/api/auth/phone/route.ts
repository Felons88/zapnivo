import { createHash, randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { normalizePhone, sendSms, smsConfigured } from "@/lib/sms";
import { serviceClient } from "@/lib/supabase";

const hash = (s: string) => createHash("sha256").update(`${s}.${process.env.HELPDESK_SECRET ?? "dev"}`).digest("hex");
const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

/** Passwordless customer sign-in: send an SMS code, verify it, then mint a Supabase magic-link session. */
export async function POST(req: Request) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const body = await req.json().catch(() => null);
  const p = z.object({ action: z.enum(["send", "verify"]), phone: z.string().min(5).max(20), code: z.string().optional() }).safeParse(body);
  if (!p.success) return NextResponse.json({ error: "Invalid request." }, { status: 422 });
  const phone = normalizePhone(p.data.phone);
  if (!phone) return NextResponse.json({ error: "Enter a valid phone number." }, { status: 422 });

  if (p.data.action === "send") {
    if (!rateLimit(`phone-send:${ip(req)}`, 4, 10 * 60_000).ok || !rateLimit(`phone-send:${phone}`, 4, 10 * 60_000).ok) {
      return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
    }
    if (!smsConfigured()) return NextResponse.json({ error: "SMS sign-in isn't available yet." }, { status: 503 });
    const code = String(randomInt(100000, 1000000));
    await db.from("phone_otps").insert({ phone, code_hash: hash(code), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    const res = await sendSms(db, { to: phone, body: `Your Zapnivo sign-in code is ${code}. It expires in 10 minutes.` });
    return NextResponse.json({ ok: true, delivered: res.sent });
  }

  const code = String(p.data.code ?? "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: "Enter the 6-digit code." }, { status: 422 });
  if (!rateLimit(`phone-verify:${ip(req)}`, 10, 10 * 60_000).ok) {
    return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
  }
  const { data: rows } = await db.from("phone_otps").select("id,code_hash,attempts")
    .eq("phone", phone).eq("used", false).gt("expires_at", new Date().toISOString()).order("id", { ascending: false }).limit(1);
  const row = rows?.[0] as { id: number; code_hash: string; attempts: number } | undefined;
  if (!row || row.attempts >= 5) return NextResponse.json({ error: "Code expired — request a new one." }, { status: 401 });
  if (row.code_hash !== hash(code)) {
    await db.from("phone_otps").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return NextResponse.json({ error: "Wrong code." }, { status: 401 });
  }
  await db.from("phone_otps").update({ used: true }).eq("id", row.id);

  let { data: profile } = await db.from("profiles").select("id,email,role").eq("phone", phone).maybeSingle();
  if (!profile?.email) {
    // Kiosk renter: their phone lives on payments.customer_phone — resolve the receipt email.
    const { data: pay } = await db.from("payments").select("receipt_email").eq("customer_phone", phone).not("receipt_email", "is", null).limit(1);
    const email = (pay?.[0] as { receipt_email?: string } | undefined)?.receipt_email ?? null;
    if (!email) return NextResponse.json({ error: "No rentals on that number yet.", code: "no_account" }, { status: 404 });
    ({ data: profile } = await db.from("profiles").select("id,email,role").ilike("email", email).maybeSingle());
    if (profile?.id) await db.from("profiles").update({ phone }).eq("id", profile.id).is("phone", null);
  }
  if (!profile?.email) {
    // Brand-new user from a kiosk receipt — magiclink generates the auth user on first use.
    const { data: pay } = await db.from("payments").select("receipt_email").eq("customer_phone", phone).not("receipt_email", "is", null).limit(1);
    const email = (pay?.[0] as { receipt_email?: string } | undefined)?.receipt_email ?? null;
    if (!email) return NextResponse.json({ error: "No rentals on that number yet.", code: "no_account" }, { status: 404 });
    const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo: `${new URL(req.url).origin}/api/auth/callback` } });
    if (lErr || !link.properties?.action_link) return NextResponse.json({ error: "Couldn't create the session." }, { status: 500 });
    return NextResponse.json({ ok: true, continue_url: link.properties.action_link });
  }
  const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email: profile.email, options: { redirectTo: `${new URL(req.url).origin}/api/auth/callback` } });
  if (error || !data.properties?.action_link) return NextResponse.json({ error: "Couldn't create the session." }, { status: 500 });
  return NextResponse.json({ ok: true, continue_url: data.properties.action_link });
}
