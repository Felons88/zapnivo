import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Durable kiosk command queue backed by `device_commands` (unique idempotency_key).
 * Until a real hardware adapter is connected, commands stay `queued` — nothing is ever
 * reported as sent/acknowledged that the hardware did not confirm.
 */
export type KioskCommand = "disable" | "enable" | "reboot" | "unlock_slot";

export async function queueCommand(
  db: SupabaseClient,
  c: { kioskId: string; command: KioskCommand; issuedBy: string | null; payload?: Record<string, unknown>; key?: string },
) {
  const idempotency_key = c.key ?? `${c.command}:${c.kioskId}:${Date.now()}`;
  const issued = c.issuedBy && /^[0-9a-f-]{36}$/i.test(c.issuedBy) ? c.issuedBy : null;
  const { data, error } = await db.from("device_commands")
    .insert({ kiosk_id: c.kioskId, command: c.command, idempotency_key, issued_by: issued, payload: c.payload ?? null })
    .select("id,status").single();
  if (error?.code === "23505") return { duplicate: true as const }; // same key already queued — safe no-op
  if (error) throw new Error("command_queue_failed");
  return { duplicate: false as const, id: data.id as string, status: data.status as string };
}

/** Expire commands that no adapter picked up within a day so the queue never silently grows stale. */
export async function expireStaleCommands(db: SupabaseClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const { data } = await db.from("device_commands").update({ status: "expired", resolved_at: now.toISOString() })
    .eq("status", "queued").lt("created_at", cutoff).select("id");
  return data?.length ?? 0;
}
