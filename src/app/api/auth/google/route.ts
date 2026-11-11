import { NextResponse, type NextRequest } from "next/server";
import { oauthClient } from "@/lib/supabase";
import { authCallbackOrigin } from "@/lib/auth-callback-origin";
import { withNextParam } from "@/lib/auth-next";

/**
 * Starts Google OAuth (PKCE). The redirect goes through Supabase back to
 * /api/auth/callback ON THIS HOST — the code-verifier cookie is host-bound, so
 * sign-in must start and finish on the same subdomain.
 */
export async function GET(req: NextRequest) {
  const callbackOrigin = authCallbackOrigin(req);
  if (!callbackOrigin) return NextResponse.json({ error: "Rejected." }, { status: 403 });
  const oauth = oauthClient(req);
  if (!oauth) return NextResponse.json({ error: "Sign-in is not configured yet.", code: "auth_unconfigured" }, { status: 503 });

  // Callback must land on the same host — the code-verifier cookie is host-bound.
  // ?next= rides on redirectTo (sanitized; Supabase preserves it when appending `code`).
  const { data, error } = await oauth.client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: withNextParam(`${callbackOrigin}/api/auth/callback`, req.nextUrl.searchParams.get("next")) },
  });
  if (error || !data.url) return oauth.apply(NextResponse.redirect(new URL("/login?error=oauth", req.url)));
  return oauth.apply(NextResponse.redirect(data.url));
}
