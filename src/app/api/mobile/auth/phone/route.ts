import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authCallbackOrigin } from "@/lib/auth-callback-origin";
import { rateLimit } from "@/lib/rate-limit";
import { normalizePhone, sendSms, smsConfigured } from "@/lib/sms";
import { anonClient, serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["send", "verify"]),
  phone: z.string().min(5).max(20),
  code: z.string().optional(),
});
const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
const secret = () => process.env.MOBILE_AUTH_SECRET || process.env.HELPDESK_SECRET || (process.env.NODE_ENV === "production" ? null : "mobile-auth-dev");
const digest = (value: string) => {
  const key = secret();
  return key ? createHmac("sha256", key).update(value).digest("hex") : null;
};
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** SMS proves phone ownership. New numbers get a customer account, never access to a receipt email's old account. */
export async function POST(req: NextRequest) {
  const origin = authCallbackOrigin(req);
  if (!origin || (req.headers.get("origin") && req.headers.get("origin") !== origin)) return json({ error: "Rejected." }, 403);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid request." }, 422);
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return json({ error: "Enter a valid phone number." }, 422);
  const db = serviceClient();
  const anon = anonClient();
  if (!db || !anon || !secret()) return json({ error: "Sign-in is not configured yet." }, 503);

  if (parsed.data.action === "send") {
    if (!smsConfigured()) return json({ error: "SMS sign-in is not available yet." }, 503);
    if (!rateLimit(`mobile-phone-send:${ip(req)}`, 4, 10 * 60_000).ok ||
        !rateLimit(`mobile-phone-send:${phone}`, 4, 10 * 60_000).ok) {
      return json({ error: "Too many codes requested. Try again later." }, 429);
    }
    const code = String(randomInt(100000, 1000000));
    const codeHash = digest(`${phone}.${code}`);
    if (!codeHash) return json({ error: "Sign-in is not configured yet." }, 503);
    await db.from("phone_otps").update({ used: true }).eq("phone", phone).eq("used", false);
    const { data: otp, error } = await db.from("phone_otps")
      .insert({ phone, code_hash: codeHash, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() })
      .select("id").single();
    if (error || !otp) return json({ error: "Couldn't create a code. Try again." }, 503);
    const sms = await sendSms(db, { to: phone, body: `Your Zapnivo sign-in code is ${code}. It expires in 10 minutes.`, kind: "auth_code", redactBody: true });
    if (!sms.sent) {
      await db.from("phone_otps").update({ used: true }).eq("id", otp.id);
      return json({ error: "Couldn't send the code. Try again later." }, 503);
    }
    return json({ ok: true, expires_in_seconds: 600 });
  }

  const code = parsed.data.code?.trim() ?? "";
  if (!/^\d{6}$/.test(code)) return json({ error: "Enter the 6-digit code." }, 422);
  if (!rateLimit(`mobile-phone-verify:${ip(req)}`, 10, 10 * 60_000).ok ||
      !rateLimit(`mobile-phone-verify:${phone}`, 10, 10 * 60_000).ok) {
    return json({ error: "Too many attempts. Try again later." }, 429);
  }
  const { data: otp, error: readError } = await db.from("phone_otps").select("id,code_hash,attempts")
    .eq("phone", phone).eq("used", false).gt("expires_at", new Date().toISOString())
    .order("id", { ascending: false }).limit(1).maybeSingle();
  if (readError) return json({ error: "Sign-in is temporarily unavailable." }, 503);
  const expected = digest(`${phone}.${code}`);
  const stored = otp?.code_hash ?? "";
  const matches = Boolean(otp && expected && otp.attempts < 5 && stored.length === expected.length &&
    timingSafeEqual(Buffer.from(stored), Buffer.from(expected)));
  if (!matches) {
    if (otp) await db.from("phone_otps").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
    return json({ error: "Wrong or expired code." }, 401);
  }
  const { data: used } = await db.from("phone_otps").update({ used: true }).eq("id", otp!.id).eq("used", false).select("id").maybeSingle();
  if (!used) return json({ error: "This code was already used. Request a new one." }, 401);

  const { data: bound, error: profileError } = await db.from("profiles")
    .select("id,email,role").eq("phone", phone).maybeSingle();
  if (profileError) return json({ error: "Sign-in is temporarily unavailable." }, 503);
  if (bound && bound.role !== "customer") return json({ error: "Use the website to sign in to this account." }, 403);
  // Synthetic mailbox for new phone-only accounts; no old receipt email is linked by guessing.
  const email = bound?.email || `phone-${digest(phone)!.slice(0, 40)}@mobile.zapnivo.com`;
  const { data: link, error: linkError } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (linkError || !link?.properties?.hashed_token) return json({ error: "Couldn't finish sign-in. Request a new code." }, 503);
  const { data: auth, error: authError } = await anon.auth.verifyOtp({
    token_hash: link.properties.hashed_token, type: "magiclink",
  });
  if (authError || !auth.session || !auth.user) return json({ error: "Couldn't finish sign-in. Request a new code." }, 503);
  if (!bound) {
    const { error: attachError } = await db.from("profiles").update({ phone }).eq("id", auth.user.id).eq("role", "customer");
    if (attachError) return json({ error: "This number is linked to another account. Contact support." }, 409);
  }
  return json({ access_token: auth.session.access_token, refresh_token: auth.session.refresh_token });
}
