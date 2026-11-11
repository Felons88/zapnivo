import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import {
  ALLOWED_COMMAND_TYPES, getSystemDevice, isAllowedCommandType, listDeviceCommands, recordDeviceCommand,
} from "@/lib/system/kiosks";

const postSchema = z.object({
  command_type: z.string().trim().min(1).max(60),
  idempotency_key: z.string().trim().min(8).max(120),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/**
 * GET /api/system/kiosks/[id]/commands — command history for a device.
 * Permission: system.kiosks.view. Read-only.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  const commands = await listDeviceCommands(g.db, device.id);
  return NextResponse.json({ commands });
}

/**
 * POST /api/system/kiosks/[id]/commands — record a read-only command request.
 * Permission: system.kiosks.manage.
 *
 * Allowed types: status_request | inventory_request | firmware_version_request.
 * ANY other type (dispense/reboot/unlock_slot/…) → 400. Because KIOSK_ADAPTER=none
 * there is no dispatch path: every accepted command is stored state='failed' with
 * result.reason='adapter_disabled' — no code path may mark 'sent'/'acked' without
 * a real adapter. Duplicate idempotency_key → 409. Audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const device = await getSystemDevice(g.db, id);
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const body = await readJson(req);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues, allowed_types: ALLOWED_COMMAND_TYPES }, { status: 400 });
  }
  if (!isAllowedCommandType(parsed.data.command_type)) {
    return NextResponse.json(
      { error: `Unsupported command_type "${parsed.data.command_type}"`, allowed_types: ALLOWED_COMMAND_TYPES },
      { status: 400 },
    );
  }
  const result = await recordDeviceCommand(g.db, device, {
    commandType: parsed.data.command_type,
    idempotencyKey: parsed.data.idempotency_key,
    payload: parsed.data.payload,
  }, { id: g.user.id, role: g.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ command: result.command }, { status: 201 });
}
