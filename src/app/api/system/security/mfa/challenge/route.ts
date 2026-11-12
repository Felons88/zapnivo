import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "../../../_shared";
import { mfaGuard } from "../_guard";
import { challengeTotp } from "@/lib/system/mfa";

const schema = z.object({ factor_id: z.string().min(8).max(120) });

/**
 * POST /api/system/security/mfa/challenge — issue a TOTP challenge for a factor.
 * The challenge id expires quickly; pair it with /verify.
 */
export async function POST(req: Request) {
  const g = await mfaGuard("challenge", 30);
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const res = await challengeTotp(g.token, parsed.data.factor_id);
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status === 401 ? 401 : 502 });
  }
  return NextResponse.json(res.data);
}
