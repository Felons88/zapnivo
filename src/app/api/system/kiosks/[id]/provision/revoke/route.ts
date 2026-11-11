import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../../_shared";
import { getSystemDevice, revokeProvisionToken } from "@/lib/system/kiosks";

/**
 * POST /api/system/kiosks/[id]/provision/revoke — clears the stored provisioning
 * token hash + expiry so a previously issued (unused) token can never be redeemed.
 * Permission: system.kiosks.manage. Audited (hash itself is never logged).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 10 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const result = await revokeProvisionToken(g.db, device, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ device: result.device });
}
