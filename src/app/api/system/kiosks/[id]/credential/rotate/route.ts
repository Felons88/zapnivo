import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../../_shared";
import { getDeviceAuthRow, startCredentialRotation } from "@/lib/system/device-auth";
import { requireElevation } from "@/lib/system/elevation";

/**
 * POST /api/system/kiosks/[id]/credential/rotate — start a ZERO-DOWNTIME
 * credential rotation. Permission: system.kiosks.manage + step-up elevation
 * (403 step_up_required without a live MFA elevation).
 *
 * Generates a new secret, stages it in device_secret_enc_next (KEK-encrypted,
 * AAD=device.id, 72h window) and returns the raw secret EXACTLY ONCE. The
 * CURRENT credential stays fully valid — the device keeps working on the old
 * secret until it authenticates once with the new one, at which point the
 * staged credential is promoted automatically (see verifyDeviceAuth).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 10 });
  if (!g.ok) return g.res;
  const elev = await requireElevation(g.db, g.user);
  if (!elev.ok) {
    return NextResponse.json({ error: elev.error, code: elev.code }, { status: elev.status });
  }
  const { id } = await ctx.params;
  const device = await getDeviceAuthRow(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const result = await startCredentialRotation(g.db, device, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    secret: result.secret, // shown once — provision to the device, then it self-promotes on first auth
    next_expires_at: result.nextExpiresAt,
    warning: "Zero-downtime rotation: the current credential remains valid until the device authenticates with this new secret (72h window). Store the secret securely — only its encrypted form is kept.",
  });
}
