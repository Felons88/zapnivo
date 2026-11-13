import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { listCommandHistory } from "@/lib/system/command-ops";

export const dynamic = "force-dynamic";

const STATES = new Set([
  "queued", "sent", "awaiting_ack", "acknowledged", "confirmed", "failed",
  "timeout", "cancelled", "expired", "unknown_outcome", "requires_investigation",
]);

/**
 * GET /api/system/commands — fleet-wide command history (device_commands queue).
 * Permission: system.kiosks.view.
 *
 * Filters (query params):
 *   kiosk_id   — scope to one rental-facing kiosk (uuid)
 *   device_id  — scope to a system_devices row; resolved to bound kiosk(s) via
 *                station_id ↔ device_uid/serial_number. Unbound → empty + flag.
 *   command    — exact command type (dispense|return_slot|unlock_slot|reboot|…)
 *   state      — command status (see STATE list below)
 *   issued_by  — profile uuid
 *   from / to  — ISO timestamps on created_at
 *   rental     — rental uuid or public reference (payload match)
 *   exception  — 'open' → only commands named by an open/investigating
 *                rental_exceptions row
 *   limit      — 1..500 (default 200)
 *
 * Payloads are returned SANITIZED (credential/header-shaped keys stripped).
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;

  const sp = new URL(req.url).searchParams;
  const state = sp.get("state")?.trim() || null;
  if (state && !STATES.has(state)) {
    return NextResponse.json({ error: `Unknown state "${state}"`, states: [...STATES] }, { status: 400 });
  }
  const from = sp.get("from")?.trim() || null;
  const to = sp.get("to")?.trim() || null;
  for (const [k, v] of [["from", from], ["to", to]] as const) {
    if (v && Number.isNaN(Date.parse(v))) {
      return NextResponse.json({ error: `Invalid ${k} timestamp` }, { status: 400 });
    }
  }
  const limitRaw = sp.get("limit")?.trim();
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limitRaw && (!Number.isInteger(limit) || (limit ?? 0) < 1)) {
    return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
  }

  try {
    const result = await listCommandHistory(g.db, {
      kioskId: sp.get("kiosk_id")?.trim() || null,
      deviceId: sp.get("device_id")?.trim() || null,
      command: sp.get("command")?.trim() || null,
      state,
      issuedBy: sp.get("issued_by")?.trim() || null,
      from, to,
      rental: sp.get("rental")?.trim() || null,
      exception: sp.get("exception")?.trim() || null,
      limit,
    });
    return NextResponse.json({
      commands: result.commands,
      count: result.commands.length,
      scope: { kiosk_ids: result.kiosk_ids, unbound_device: result.unbound_device },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "query failed" }, { status: 500 });
  }
}
