import { NextResponse, type NextRequest } from "next/server";
import { ANCHOR_COOKIE, makeAnchorCookie, SESSION_COOKIE } from "@/lib/auth";
import { apexCookieDomain } from "@/lib/subdomains";
import { homeFor } from "@/lib/customer";
import { oauthClient, serviceClient } from "@/lib/supabase";
import { authCallbackOrigin } from "@/lib/auth-callback-origin";

const toLogin = (origin: string, error = "oauth") => NextResponse.redirect(`${origin}/login?error=${error}`);

/**
 * OAuth landing: exchanges the code for a session, then drops it into the shared
 * zapnivo_access cookie (Domain=zapnivo.com on the apex, so one sign-in works on
 * every subdomain) and routes the user to their portal.
 */
export async function GET(req: NextRequest) {
  const callbackOrigin = authCallbackOrigin(req);
  if (!callbackOrigin) return NextResponse.json({ error: "Rejected." }, { status: 403 });
  const code = req.nextUrl.searchParams.get("code");
  const oauth = oauthClient(req);
  if (!code || !oauth) return toLogin(callbackOrigin);

  const { data, error } = await oauth.client.auth.exchangeCodeForSession(code);
  if (error || !data.session) return oauth.apply(toLogin(callbackOrigin));

  const svc = serviceClient();
  const { data: profile } = svc
    ? await svc.from("profiles").select("role").eq("id", data.user.id).single()
    : { data: null };

  // Phone-claim binding: /api/auth/phone recorded (email, phone) after the SMS code verified.
  // Reaching this callback means the emailed link was used — inbox ownership proven — so the
  // phone↔account binding is now two-factor verified and safe to persist.
  if (svc && data.user.email) {
    const email = data.user.email.toLowerCase();
    const { data: claim } = await svc.from("phone_claims").select("phone")
      .eq("email", email).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (claim?.phone) {
      await svc.from("profiles").update({ phone: claim.phone }).eq("id", data.user.id).is("phone", null);
      await svc.from("phone_claims").delete().eq("email", email);
    }
  }
  const dest = homeFor(profile?.role);

  const res = NextResponse.redirect(`${callbackOrigin}${dest}`);
  const domain = apexCookieDomain(new URL(callbackOrigin).host);
  res.cookies.set(SESSION_COOKIE, data.session.access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.min(data.session.expires_in ?? 3600, 3600),
    domain,
  });
  const anchor = makeAnchorCookie(data.user.id, Date.now());
  if (anchor) res.cookies.set(ANCHOR_COOKIE, anchor, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 24 * 3600, domain,
  });
  return oauth.apply(res);
}
