import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { getSystemDevice, listDeviceCommands, recordDiagnosticPing, runDeviceDiagnostics } from "@/lib/system/kiosks";

/**
 * GET /api/system/kiosks/[id]/diagnostics — stored diagnostic history
 * (system_device_commands rows with command_type='diagnostic_ping').
 * Permission: system.kiosks.view. Read-only.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  const commands = await listDeviceCommands(g.db, device.id, 200);
  return NextResponse.json({ diagnostics: commands.filter((c) => c.command_type === "diagnostic_ping") });
}

/**
 * POST /api/system/kiosks/[id]/diagnostics — run bounded checks and record the
 * result. Permission: system.kiosks.manage (writes a command row → mutation).
 *
 * Checks are strictly bounded: registry row presence, heartbeat/message age from
 * stored timestamps, and KIOSK_ADAPTER env state. With adapter=none the result is
 * always 'adapter_unavailable' — a live ping is NEVER claimed. The run is stored
 * as a system_device_commands row (state='failed', honest reason) and audited.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 20 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const result = await runDeviceDiagnostics(g.db, device);
  const recorded = await recordDiagnosticPing(g.db, device, result, { id: g.user.id, role: g.role });
  return NextResponse.json({ diagnostics: result, recorded_command_id: recorded.commandId });
}
