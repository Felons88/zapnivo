import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "../../../_shared";
import { mfaGuard } from "../_guard";
import { verifyTotp } from "@/lib/system/mfa";

const schema = z.object({
  factor_id: z.string().min(8).max(120),
  challenge_id: z.string().min(8).max(120),
  code: z.string().trim().min(6).max(8),
});

/**
 * POST /api/system/security/mfa/verify — verify a TOTP code.
 * On success: grants a 15-minute elevation (method='totp') — the client shows
 * "elevated for 15 min". The code is never stored or logged.
 */
export async function POST(req: Request) {
  const g = await mfaGuard("verify", 20);
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const res = await verifyTotp(g.db, { id: g.user.id, email: g.user.email }, g.token, {
    factorId: parsed.data.factor_id,
    challengeId: parsed.data.challenge_id,
    code: parsed.data.code,
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error, elevated: false }, { status: res.status });
  }
  return NextResponse.json({ ok: true, elevatedUntil: res.elevatedUntil, elevatedMinutes: 15 });
}
