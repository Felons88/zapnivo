import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { getSessionUser, SESSION_COOKIE, devAuth } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import { attemptBootstrap, bootstrapConfigured } from "@/lib/system/identity";
import { systemRole } from "@/lib/system/rbac";

const schema = z.object({
  token: z.string().min(1).max(500),
  confirm_email: z.string().trim().email().max(320),
});

/**
 * GET /api/system/security/bootstrap — bootstrap availability for the page.
 * NOTE: deliberately NOT behind systemApiGuard — the caller has no system_role
 * yet (that is the point of bootstrap). Requires only a signed-in session.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const db = serviceClient();
  const role = user ? await systemRole(user, db) : null;
  return NextResponse.json({
    configured: bootstrapConfigured(),
    hasSystemRole: role !== null,
    email: user.email,
  });
}

/**
 * POST /api/system/security/bootstrap — one-time privileged bootstrap.
 * Grants profiles.system_role='sysadmin' to a signed-in user with NO system
 * role, gated by SYSTEM_BOOTSTRAP_TOKEN + email confirmation + a verified
 * TOTP factor. Replay is impossible (grant row + non-null role both block).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const rl = rateLimit(`system:bootstrap:${user.id}`, 5, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfter) } });
  }
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const accessToken = devAuth() ? "" : (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const res = await attemptBootstrap(db, user, {
    token: parsed.data.token,
    confirmEmail: parsed.data.confirm_email,
    accessToken,
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error, code: res.code }, { status: res.status });
  }
  return NextResponse.json({ ok: true, systemRole: "sysadmin" });
}
