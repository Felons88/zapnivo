import { NextResponse } from "next/server";
import { mfaGuard } from "../_guard";
import { listFactors } from "@/lib/system/mfa";
import { activeElevation } from "@/lib/system/elevation";

/**
 * GET /api/system/security/mfa/factors — the caller's TOTP factors (from
 * Supabase Auth) plus current step-up elevation status. Never returns secrets.
 */
export async function GET() {
  const g = await mfaGuard("factors", 120);
  if (!g.ok) return g.res;
  const res = await listFactors(g.token);
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status === 401 ? 401 : 502 });
  }
  const elev = await activeElevation(g.db, g.user.id);
  return NextResponse.json({
    factors: res.data.totp,
    verified: res.data.totp.some((f) => f.status === "verified"),
    elevation: elev ? { method: elev.method, expiresAt: elev.expires_at } : null,
  });
}
