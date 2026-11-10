import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { oauthClient } from "@/lib/supabase";

const schema = z.object({ email: z.string().trim().email().max(254), website: z.string().max(200).optional() });

/**
 * Passwordless sign-in (PKCE). Same host rules as /api/auth/google: the code-verifier cookie is
 * host-bound, so the emailed link must land on THIS host's /api/auth/callback.
 * Always answers the same way for any valid address so it can't be used to probe accounts.
 */
export async function POST(req: NextRequest) {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== host) return NextResponse.json({ error: "Rejected." }, { status: 403 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (!rateLimit(`email-link:${ip}`, 5, 10 * 60_000).ok) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email address." }, { status: 422 });
  if (parsed.data.website) return NextResponse.json({ ok: true }); // honeypot
  if (!rateLimit(`email-link-to:${parsed.data.email.toLowerCase()}`, 3, 10 * 60_000).ok) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  const oauth = oauthClient(req);
  if (!oauth) return NextResponse.json({ error: "Sign-in is not configured yet.", code: "auth_unconfigured" }, { status: 503 });

  const { error } = await oauth.client.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: `${req.nextUrl.protocol}//${host}/api/auth/callback`, shouldCreateUser: true },
  });
  if (error) {
    console.error(JSON.stringify({ level: "error", scope: "email-link", msg: error.message }));
    return oauth.apply(NextResponse.json({ error: "We couldn't send the link. Please try again." }, { status: 502 }));
  }
  return oauth.apply(NextResponse.json({ ok: true }));
}
