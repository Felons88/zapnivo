import { serviceClient } from "./supabase";

/** Best-effort audit trail for admin actions. Never throws — auditing must not break the action itself. */
export async function auditLog(actor: string | null, action: string, entity: string, entityId?: string | null, detail?: Record<string, unknown>) {
  try {
    const db = serviceClient();
    if (!db) return;
    // actor must be a profiles.id (uuid); dev-store synthetic users are skipped.
    const uuid = actor && /^[0-9a-f-]{36}$/i.test(actor) ? actor : null;
    await db.from("audit_logs").insert({ actor: uuid, action, entity, entity_id: entityId ?? null, detail: detail ?? null });
  } catch { /* ignore */ }
}
