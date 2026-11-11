import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { normalizePhone, sendSms, smsConfigured } from "@/lib/sms";
import { getSessionUser } from "@/lib/auth";
import { oauthClient, serviceClient } from "@/lib/supabase";
import { authCallbackOrigin } from "@/lib/auth-callback-origin";
import { recordLog } from "@/lib/observability";

const secret = () => {
  const s = process.env.HELPDESK_SECRET;
  if (!s && process.env.NODE_ENV === "production") return null;
  return s ?? "dev";
};
const hash = (s: string) => {
  const sec = secret();
  return sec ? createHash("sha256").update(`${s}.${sec}`).digest("hex") : null;
};
const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

/** Passwordless customer sign-in: SMS code proves the phone; the follow-up email link proves the mailbox. */
export async function POST(req: NextRequest) {
  const callbackOrigin = authCallbackOrigin(req);
  if (!callbackOrigin) return NextResponse.json({ error: "Rejected." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  if (!secret()) return NextResponse.json({ error: "Auth is not configured." }, { status: 503 });
  const body = await req.json().catch(() => null);
  const p = z.object({ action: z.enum(["send", "verify", "link_send", "link_verify"]), phone: z.string().min(5).max(20), code: z.string().optional() }).safeParse(body);
  if (!p.success) return NextResponse.json({ error: "Invalid request." }, { status: 422 });
  // Action + outcome only — never the phone number or OTP.
  const FAIL_RESULTS = new Set(["wrong_code", "send_failed", "session_failed", "link_failed", "email_link_failed"]);
  const log = (result: string, attrs?: Record<string, unknown>) =>
    recordLog(FAIL_RESULTS.has(result) ? "warning" : "info",
      `phone_auth_${p.data.action}`, { service: "auth", route: "auth/phone", attrs: { action: p.data.action, result, ...attrs } });
  const phone = normalizePhone(p.data.phone);
  if (!phone) return NextResponse.json({ error: "Enter a valid phone number." }, { status: 422 });

  // ── Authenticated phone linking (account settings): session proves identity, OTP proves the phone.
  if (p.data.action === "link_send" || p.data.action === "link_verify") {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    if (p.data.action === "link_send") {
      if (!rateLimit(`phone-link:${user.id}`, 4, 10 * 60_000).ok) return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
      if (!smsConfigured()) return NextResponse.json({ error: "SMS isn't available yet." }, { status: 503 });
      const code = String(randomInt(100000, 1000000));
      await db.from("phone_otps").insert({ phone, code_hash: hash(code), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
      const res = await sendSms(db, { to: phone, body: `Your Zapnivo phone-verification code is ${code}. It expires in 10 minutes.` });
      log(res.sent ? "delivered" : "send_failed");
      return NextResponse.json({ ok: true, delivered: res.sent });
    }
    const code = String(p.data.code ?? "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: "Enter the 6-digit code." }, { status: 422 });
    if (!rateLimit(`phone-link-v:${user.id}`, 10, 10 * 60_000).ok) return NextResponse.json({ error: "Too many attempts." }, { status: 429 });
    const { data: rows } = await db.from("phone_otps").select("id,code_hash,attempts")
      .eq("phone", phone).eq("used", false).gt("expires_at", new Date().toISOString()).order("id", { ascending: false }).limit(1);
    const row = rows?.[0] as { id: number; code_hash: string; attempts: number } | undefined;
    const want = hash(code);
    const ok = !!row && !!want && row.attempts < 5 &&
      row.code_hash.length === want.length && timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(want));
    if (!ok) {
      if (row) await db.from("phone_otps").update({ attempts: row.attempts + 1 }).eq("id", row.id);
      log("wrong_code", { hadRow: Boolean(row) });
      return NextResponse.json({ error: "Wrong or expired code." }, { status: 401 });
    }
    await db.from("phone_otps").update({ used: true }).eq("id", row.id);
    const { error: upErr } = await db.from("profiles").update({ phone }).eq("id", user.id);
    if (upErr) { log("link_failed", { reason: "profile_conflict" }); return NextResponse.json({ error: "Couldn't save the number — it may be linked to another account." }, { status: 409 }); }
    log("ok");
    return NextResponse.json({ ok: true });
  }

  if (p.data.action === "send") {
    if (!rateLimit(`phone-send:${ip(req)}`, 4, 10 * 60_000).ok || !rateLimit(`phone-send:${phone}`, 4, 10 * 60_000).ok) {
      return NextResponse.json({ error: "Too many attempts — try again later." }, { status: 429 });
    }
    if (!smsConfigured()) return NextResponse.json({ error: "SMS sign-in isn't available yet." }, { status: 503 });
    const code = String(randomInt(100000, 1000000));
    await db.from("phone_otps").update({ used: true }).eq("phone", phone).eq("used", false);
    await db.from("phone_otps").insert({ phone, code_hash: hash(code), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    const res = await sendSms(db, { to: phone, body: `Your Zapnivo sign-in code is ${code}. It expires in 10 minutes.` });
    log(res.sent ? "delivered" : "send_failed");
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
  const want = hash(code);
  const ok = !!row && !!want && row.attempts < 5 &&
    row.code_hash.length === want.length && timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(want));
  if (!ok) {
    if (row) await db.from("phone_otps").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    log("wrong_code", { hadRow: Boolean(row) });
    return NextResponse.json({ error: "Wrong code." }, { status: 401 });
  }
  await db.from("phone_otps").update({ used: true }).eq("id", row.id);

  // Fast path: this phone was previously verified and bound to an account.
  const { data: bound } = await db.from("profiles").select("email").eq("phone", phone).maybeSingle();
  if (bound?.email) {
    const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email: bound.email, options: { redirectTo: `${callbackOrigin}/api/auth/callback` } });
    if (error || !data.properties?.action_link) { log("session_failed"); return NextResponse.json({ error: "Couldn't create the session." }, { status: 500 }); }
    log("ok", { path: "bound_profile" });
    return NextResponse.json({ ok: true, continue_url: data.properties.action_link });
  }

  // Checkout phones are customer-typed and unverified — the email on file is only a *candidate*.
  // The session is never minted here: we record a phone_claim and email a Supabase sign-in link
  // to the receipt address, so inbox ownership is the second factor. The callback binds the
  // phone to the profile only after that verified sign-in.
  const { data: pays } = await db.from("payments").select("receipt_email").eq("customer_phone", phone).not("receipt_email", "is", null).limit(10);
  const emails = [...new Set((pays ?? []).map((r) => String((r as { receipt_email?: string }).receipt_email ?? "").toLowerCase()).filter(Boolean))];
  if (emails.length === 0) { log("no_account"); return NextResponse.json({ error: "No rentals on that number yet.", code: "no_account" }, { status: 404 }); }
  if (emails.length > 1) { log("ambiguous_email", { candidateCount: emails.length }); return NextResponse.json({ error: "More than one email is on file for that number — sign in with email instead.", code: "ambiguous_email" }, { status: 409 }); }

  const email = emails[0];
  await db.from("phone_claims").delete().eq("email", email);
  await db.from("phone_claims").insert({ email, phone, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });

  const oauth = oauthClient(req);
  if (!oauth) return NextResponse.json({ error: "Sign-in is not configured yet." }, { status: 503 });
  const { error: otpErr } = await oauth.client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${callbackOrigin}/api/auth/callback`, shouldCreateUser: true },
  });
  if (otpErr) {
    console.error(JSON.stringify({ level: "error", scope: "phone-verify", msg: otpErr.message }));
    log("email_link_failed");
    return NextResponse.json({ error: "We couldn't send the sign-in link. Try email sign-in instead." }, { status: 502 });
  }
  log("email_link_sent");
  return oauth.apply(NextResponse.json({ ok: true, sent: "email_link" }));
}
