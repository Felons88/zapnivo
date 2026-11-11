import { NextResponse } from "next/server";
import { systemApiGuard, readJson } from "../../_shared";
import { registerKiosk, registerKioskSchema } from "@/lib/system/kiosks";

/**
 * POST /api/system/kiosks/register — add a device to the system_devices fleet
 * registry (status='registered', device_uid `kiosk-<random>` generated server-side).
 *
 * Permission: system.kiosks.manage (the narrower system.kiosks.register does not
 * exist in SYSTEM_PERMISSIONS yet — see src/lib/system/kiosks.ts header note).
 * Duplicate serial_number → honest 409. Audited (no secrets involved).
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 20 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = registerKioskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const result = await registerKiosk(g.db, parsed.data, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ device: result.device }, { status: 201 });
}
