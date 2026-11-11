import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";

const DEVICE_STATUSES = ["pending", "registered", "provisioning", "testing", "active", "maintenance", "suspended", "quarantined", "decommissioned"];

/**
 * GET /api/system/devices — minimal fleet listing (Stage 1).
 * Read-only; provisioning/commands land in later stages.
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);

  let q = g.db.from("system_devices")
    .select("id,device_uid,serial_number,manufacturer,model,gateway,adapter_type,capabilities,slot_count,firmware_version,venue_id,region,status,credential_rotated_at,installed_at,last_heartbeat_at,last_message_at,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status && DEVICE_STATUSES.includes(status)) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ devices: data ?? [], count: (data ?? []).length });
}
