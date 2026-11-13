import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import {
  getSystemDevice, runDeviceDiagnostics, recordDiagnosticPing,
} from "@/lib/system/kiosks";
import { assignDeviceTags, proposeConfig, approveConfig, dispatchConfig } from "@/lib/system/device-config";

/**
 * POST /api/system/kiosks/bulk — safe-subset fleet operations.
 * Permission: system.kiosks.manage.
 *
 * ALLOWED actions (each audited per device, partial failure reported honestly):
 *   assign_tags          { device_ids, tags }            → metadata.tags
 *   schedule_diagnostics { device_ids }                  → diagnostic_ping command per device
 *   set_maintenance_flag { device_ids, maintenance_mode } → device-config
 *                        propose→approve→dispatch per device (adapter=none →
 *                        command recorded failed/adapter_disabled honestly)
 *
 * PHYSICAL / dispatch actions are REJECTED with 403 — bulk can never reboot,
 * dispense, unlock slots, flash firmware, or push arbitrary commands:
 *   reboot | dispense | return_slot | unlock_slot | firmware_update |
 *   config_update | command | enable | disable | … → 403
 * Unknown actions → 400.
 */

const BULK_ACTIONS = ["assign_tags", "schedule_diagnostics", "set_maintenance_flag"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

/** Action names that would affect physical hardware / dispatch — always 403. */
const PHYSICAL_ACTIONS = new Set([
  "reboot", "dispense", "return_slot", "unlock_slot", "firmware_update",
  "firmware_flash", "config_update", "command", "enable", "disable",
  "power_cycle", "calibrate", "factory_reset", "update_firmware",
]);

const postSchema = z.object({
  action: z.string().trim().min(1).max(60),
  device_ids: z.array(z.string().uuid()).min(1).max(100),
  tags: z.array(z.unknown()).max(20).optional(),
  maintenance_mode: z.boolean().optional(),
  justification: z.string().trim().max(500).optional(),
}).strict();

type DeviceResult = { device_id: string; ok: boolean; detail?: string; error?: string };

export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 10, windowMs: 60_000 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues, allowed_actions: BULK_ACTIONS }, { status: 400 });
  }
  const { action, device_ids } = parsed.data;

  if (PHYSICAL_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: `Bulk action "${action}" is not permitted — physical/dispatch commands require per-device flows with their own gates.`, allowed_actions: BULK_ACTIONS },
      { status: 403 },
    );
  }
  if (!(BULK_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: `Unknown bulk action "${action}"`, allowed_actions: BULK_ACTIONS }, { status: 400 });
  }

  const actor = { id: g.user.id, role: g.role };
  const results: DeviceResult[] = [];

  for (const deviceId of device_ids) {
    const device = await getSystemDevice(g.db, deviceId);
    if (!device) {
      results.push({ device_id: deviceId, ok: false, error: "Device not found" });
      continue;
    }
    try {
      if (action === "assign_tags") {
        const r = await assignDeviceTags(g.db, device, (parsed.data.tags ?? []) as string[], actor);
        results.push(r.ok
          ? { device_id: deviceId, ok: true, detail: `tags=${r.tags.join(",") || "(cleared)"}` }
          : { device_id: deviceId, ok: false, error: r.error });
      } else if (action === "schedule_diagnostics") {
        const diag = await runDeviceDiagnostics(g.db, device);
        const rec = await recordDiagnosticPing(g.db, device, diag, actor);
        results.push(rec.recorded
          ? { device_id: deviceId, ok: true, detail: `diagnostic recorded (command ${rec.commandId?.slice(0, 8) ?? "?"}, status=${diag.status})` }
          : { device_id: deviceId, ok: true, detail: `diagnostic run ${diag.status} (command row not recorded)` });
      } else {
        // set_maintenance_flag → full config pipeline per device.
        if (parsed.data.maintenance_mode === undefined) {
          results.push({ device_id: deviceId, ok: false, error: "maintenance_mode boolean required" });
          continue;
        }
        const prop = await proposeConfig(g.db, device, { maintenance_mode: parsed.data.maintenance_mode }, actor);
        if (!prop.ok) {
          results.push({ device_id: deviceId, ok: false, error: `propose: ${prop.error}${prop.pending ? " (change request pending)" : ""}` });
          continue;
        }
        const appr = await approveConfig(g.db, device, prop.revision.id, actor, parsed.data.justification);
        if (!appr.ok) {
          results.push({ device_id: deviceId, ok: false, error: `approve: ${appr.error}${appr.pending ? " (change request pending)" : ""}` });
          continue;
        }
        const disp = await dispatchConfig(g.db, device, appr.revision.id, actor);
        results.push(disp.ok
          ? { device_id: deviceId, ok: true, detail: `revision ${disp.revision.revision} → ${disp.revision.status} (dispatched=${disp.dispatched})` }
          : { device_id: deviceId, ok: false, error: `dispatch: ${disp.error}` });
      }
    } catch (e) {
      results.push({ device_id: deviceId, ok: false, error: e instanceof Error ? e.message : "unexpected error" });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return NextResponse.json({
    action, total: results.length, succeeded, failed: results.length - succeeded, results,
  }, { status: succeeded === results.length ? 200 : succeeded === 0 ? 207 : 207 });
}
