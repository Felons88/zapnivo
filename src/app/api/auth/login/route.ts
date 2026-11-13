import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { ANCHOR_COOKIE, makeAnchorCookie, revokeCurrentSession, SESSION_COOKIE } from "@/lib/auth";
import { apexCookieDomain, isSystemHost } from "@/lib/subdomains";
import { homeFor } from "@/lib/customer";
import { anonClient, serviceClient } from "@/lib/supabase";

const schema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });

/** Share the session cookie across zapnivo.com subdomains; host-only elsewhere (localhost, previews). */
const cookieDomain = (req: Request) => apexCookieDomain(req.headers.get("host") ?? "");

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin) {
    try { if (new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Rejected." }, { status: 403 }); }
    catch { return NextResponse.json({ error: "Rejected." }, { status: 403 }); }
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (!rateLimit(`login:${ip}`, 8, 10 * 60_000).ok) return NextResponse.json({ error: "Too many attempts." }, { status: 429 });

  const anon = anonClient();
  if (!anon) return NextResponse.json({ error: "Sign-in is not configured yet.", code: "auth_unconfigured" }, { status: 503 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter your email and password." }, { status: 422 });

  const { data, error } = await anon.auth.signInWithPassword(parsed.data);
  if (error || !data.session) return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });

  const svc = serviceClient();
  const { data: profile } = svc
    ? await svc.from("profiles").select("role, system_role").eq("id", data.user.id).single()
    : { data: null };

  const home = isSystemHost(req.headers.get("host") ?? "") && profile?.system_role ? "/system" : homeFor(profile?.role);
  const res = NextResponse.json({ ok: true, role: profile?.role ?? null, home });
  const domain = cookieDomain(req);
  res.cookies.set(SESSION_COOKIE, data.session.access_token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: Math.min(data.session.expires_in, 3600), domain,
  });
  const anchor = makeAnchorCookie(data.user.id, Date.now());
  if (anchor) res.cookies.set(ANCHOR_COOKIE, anchor, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 24 * 3600, domain,
  });
  return res;
}

export async function DELETE(req: Request) {
  const origin = req.headers.get("origin");
  if (origin) {
    try { if (new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Rejected." }, { status: 403 }); }
    catch { return NextResponse.json({ error: "Rejected." }, { status: 403 }); }
  }
  await revokeCurrentSession();
  const res = NextResponse.json({ ok: true });
  const domain = cookieDomain(req);
  res.cookies.delete({ name: SESSION_COOKIE, path: "/", domain });
  res.cookies.delete({ name: ANCHOR_COOKIE, path: "/", domain });
  return res;
}
