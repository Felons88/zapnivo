import { NextResponse, type NextRequest } from "next/server";
import { oauthClient } from "@/lib/supabase";

/**
 * Starts Google OAuth (PKCE). The redirect goes through Supabase back to
 * /api/auth/callback ON THIS HOST — the code-verifier cookie is host-bound, so
 * sign-in must start and finish on the same subdomain.
 */
export async function GET(req: NextRequest) {
  const oauth = oauthClient(req);
  if (!oauth) return NextResponse.json({ error: "Sign-in is not configured yet.", code: "auth_unconfigured" }, { status: 503 });

  // Callback must land on the same host — the code-verifier cookie is host-bound.
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const { data, error } = await oauth.client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${req.nextUrl.protocol}//${host}/api/auth/callback` },
  });
  if (error || !data.url) return oauth.apply(NextResponse.redirect(new URL("/login?error=oauth", req.url)));
  return oauth.apply(NextResponse.redirect(data.url));
}
