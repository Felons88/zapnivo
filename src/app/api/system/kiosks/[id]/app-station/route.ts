import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { createAppStationForDevice, getSystemDevice } from "@/lib/system/kiosks";

/** Repair an older registered device that predates app station creation. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 20 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  const result = await createAppStationForDevice(g.db, device, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ station_id: result.stationId }, { status: 201 });
}
