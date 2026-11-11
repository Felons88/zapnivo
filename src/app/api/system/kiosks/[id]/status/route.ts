import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { getSystemDevice, isSystemDeviceStatus, setDeviceStatus, SYSTEM_DEVICE_STATUSES } from "@/lib/system/kiosks";

const bodySchema = z.object({
  status: z.enum(SYSTEM_DEVICE_STATUSES),
  justification: z.string().trim().max(2000).optional(),
});

/**
 * POST /api/system/kiosks/[id]/status — lifecycle transition.
 * Permission: system.kiosks.manage. Illegal edges → 409; high-risk targets
 * (quarantined/decommissioned) and breakglass actors require an approved change
 * request → 202 with changeRequestId when pending. Audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const body = await readJson(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success || !isSystemDeviceStatus(parsed.data.status)) {
    return NextResponse.json({ error: "Invalid status", allowed: SYSTEM_DEVICE_STATUSES }, { status: 400 });
  }
  const result = await setDeviceStatus(g.db, device, parsed.data.status, { id: g.user.id, role: g.role }, parsed.data.justification);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, pending: result.pending ?? false, changeRequestId: result.changeRequestId ?? null },
      { status: result.status },
    );
  }
  return NextResponse.json({ device: result.device });
}
