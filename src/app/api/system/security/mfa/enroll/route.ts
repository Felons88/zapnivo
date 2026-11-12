import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { z } from "zod";
import { readJson } from "../../../_shared";
import { mfaGuard } from "../_guard";
import { enrollTotp } from "@/lib/system/mfa";
import { systemAudit } from "@/lib/system/audit";

const schema = z.object({
  friendly_name: z.string().trim().max(120).optional(),
});

/**
 * POST /api/system/security/mfa/enroll — start TOTP enrollment.
 * Returns the factor id, base32 secret, otpauth URI and a QR data-URL ONCE.
 * The secret lives only in Supabase auth.mfa_factors — nothing is persisted here.
 */
export async function POST(req: Request) {
  const g = await mfaGuard("enroll", 20);
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const res = await enrollTotp(g.token, { friendlyName: parsed.data.friendly_name });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status === 401 ? 401 : 502 });
  }
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "mfa.enroll.started",
    resource: `profile:${g.user.id}`,
    detail: { factor_id: res.data.factorId },
  });
  let qrDataUrl: string | null = null;
  try { qrDataUrl = await QRCode.toDataURL(res.data.uri, { margin: 1, width: 220 }); } catch { qrDataUrl = null; }
  return NextResponse.json({
    factorId: res.data.factorId,
    secret: res.data.secret,
    uri: res.data.uri,
    qrCode: qrDataUrl,
    note: "Save the secret now — it is shown once and never stored by Zapnivo.",
  });
}
