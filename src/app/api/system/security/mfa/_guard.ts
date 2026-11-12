import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { rateLimit } from "@/lib/rate-limit";
import { getSessionUser, SESSION_COOKIE, devAuth, type SessionUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import { systemRole } from "@/lib/system/rbac";
import { mfaConfig } from "@/lib/system/mfa";
import type { SupabaseClient } from "@supabase/supabase-js";

export type MfaGuard =
  | { ok: true; user: SessionUser; db: SupabaseClient; token: string; role: string }
  | { ok: false; res: NextResponse };

/**
 * MFA endpoints are SELF-SERVICE identity routes: they act only on the caller's
 * own Supabase Auth factors, so a plain signed-in session is the correct
 * boundary — NOT a system_role. This is required for bootstrap, where the user
 * must enroll TOTP BEFORE holding any system role (chicken-and-egg). Still
 * rate-limited per user and fully audited.
 */
export async function mfaGuard(action: string, limit = 20): Promise<MfaGuard> {
  const user = await getSessionUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "Unauthenticated" }, { status: 401 }) };
  const rl = rateLimit(`system:mfa:${user.id}:${action}`, limit, 60_000);
  if (!rl.ok) {
    return { ok: false, res: NextResponse.json({ error: "Rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfter) } }) };
  }
  const db = serviceClient();
  if (!db) return { ok: false, res: NextResponse.json({ error: "Backend not configured" }, { status: 503 }) };
  if (devAuth() || !mfaConfig()) {
    return { ok: false, res: NextResponse.json({ error: "MFA requires Supabase Auth — not available in dev-store mode" }, { status: 503 }) };
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { ok: false, res: NextResponse.json({ error: "No session token" }, { status: 401 }) };
  const role = (await systemRole(user, db)) ?? "none";
  return { ok: true, user, db, token, role };
}
