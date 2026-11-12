import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../../../_shared";
import { cancelCredentialRotation, getDeviceAuthRow } from "@/lib/system/device-auth";
import { requireElevation } from "@/lib/system/elevation";

/**
 * POST /api/system/kiosks/[id]/credential/rotate/cancel — clears a pending
 * staged credential (device_secret_enc_next). The primary credential is
 * untouched. Permission: system.kiosks.manage + step-up elevation.
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

  const result = await cancelCredentialRotation(g.db, device, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ cancelled: true });
}
