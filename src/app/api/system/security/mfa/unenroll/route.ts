import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "../../../_shared";
import { mfaGuard } from "../_guard";
import { unenrollFactor } from "@/lib/system/mfa";
import { requireElevation } from "@/lib/system/elevation";
import { systemAudit } from "@/lib/system/audit";

const schema = z.object({ factor_id: z.string().min(8).max(120) });

/**
 * POST /api/system/security/mfa/unenroll — revoke a TOTP factor.
 * Requires a live step-up elevation (verify MFA first — or another elevation
 * source). Removing your LAST verified factor is allowed but audited loudly;
 * bootstrap and step-up both depend on TOTP.
 */
export async function POST(req: Request) {
  const g = await mfaGuard("unenroll", 10);
  if (!g.ok) return g.res;
  const elev = await requireElevation(g.db, g.user);
  if (!elev.ok) {
    return NextResponse.json({ error: elev.error, code: elev.code }, { status: elev.status });
  }
  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const res = await unenrollFactor(g.token, parsed.data.factor_id);
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status === 401 ? 401 : 502 });
  }
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "mfa.factor.revoked",
    resource: `profile:${g.user.id}`,
    detail: { factor_id: parsed.data.factor_id },
  });
  return NextResponse.json({ ok: true });
}
