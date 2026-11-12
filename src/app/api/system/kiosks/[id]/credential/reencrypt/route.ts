import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../../_shared";
import { reencryptDeviceCredential } from "@/lib/system/device-auth";
import { requireElevation } from "@/lib/system/elevation";

/**
 * POST /api/system/kiosks/[id]/credential/reencrypt — KEK-rotation step.
 * Permission: system.kiosks.manage + step-up elevation.
 *
 * Decrypts the device's stored credential slot(s) with ANY configured KEK
 * (current → DEVICE_CREDENTIAL_KEK_PREVIOUS), re-encrypts under the CURRENT
 * KEK, verifies the roundtrip BEFORE writing, and audits
 * kiosk.credential_reencrypted. Runbook: set DEVICE_CREDENTIAL_KEK_PREVIOUS=
 * <old>, DEVICE_CREDENTIAL_KEK=<new>, DEVICE_CREDENTIAL_KEK_VERSION=<newver>,
 * call this per device, then unset PREVIOUS. There is NO automatic rotation.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 10 });
  if (!g.ok) return g.res;
  const elev = await requireElevation(g.db, g.user);
  if (!elev.ok) {
    return NextResponse.json({ error: elev.error, code: elev.code }, { status: elev.status });
  }
  const { id } = await ctx.params;

  const result = await reencryptDeviceCredential(g.db, id, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ reencrypted: true, slots: result.slots });
}
