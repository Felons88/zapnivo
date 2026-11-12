import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../../_shared";
import { getSystemDevice } from "@/lib/system/kiosks";
import { revokeDeviceCredential, type DeviceAuthRow } from "@/lib/system/device-auth";

/**
 * POST /api/system/kiosks/[id]/credential/revoke — clears the stored credential
 * hash and stamps credential_revoked_at so the device can no longer authenticate.
 * auth_method becomes 'none'. Permission: system.kiosks.manage. Audited.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 10 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const result = await revokeDeviceCredential(g.db, device as DeviceAuthRow, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ credential: { state: "revoked" }, device: result.device });
}
