import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Durable kiosk command queue backed by `device_commands` (unique idempotency_key).
 *
 * Command state machine (migration 0052 extends the status CHECK; legacy values are
 * kept so existing rows stay valid):
 *
 *   queued → sent → awaiting_ack → acknowledged | confirmed   (terminal success)
 *                    │            └→ failed | timeout | cancelled | expired
 *                    └→ unknown_outcome   (sweep: expires_at passed, no terminal ack —
 *                                        a lost ack is NOT a failed dispense)
 *   any state → requires_investigation   (staff review workspace)
 *
 * `acknowledged` and `confirmed` are both terminal-success; `acknowledged` is what
 * the ingest path writes today, `confirmed` is reserved for adapters that
 * distinguish "accepted" from "completed". `unknown_outcome` and
 * `requires_investigation` never auto-transition on a late ack — see
 * lifecycle.ts gateCommandAck (stale_ack / conflicting_ack exceptions).
 *
 * Until a real hardware adapter is connected, commands stay `queued` — nothing is
 * ever reported as sent/acknowledged that the hardware did not confirm.
 */
export type KioskCommand =
  | "disable" | "enable" | "reboot" | "unlock_slot"
  // Physical actuation commands. The KioskCommand enum is `text` in the DB so
  // widening is safe; acks still correlate by command id / idempotency_key
  // regardless of command type (see lifecycle.ts).
  | "dispense" | "return_slot";

export type CommandStatus =
  | "queued" | "sent" | "awaiting_ack"
  | "acknowledged" | "confirmed" | "failed"
  | "timeout" | "cancelled" | "expired"
  | "unknown_outcome" | "requires_investigation";

/** States that may still legitimately receive an ack / transition. */
export const OPEN_COMMAND_STATES: ReadonlySet<string> = new Set(["queued", "sent", "awaiting_ack"]);
/** Terminal-success states (acknowledged ≡ confirmed for correlation purposes). */
export const TERMINAL_SUCCESS_STATES: ReadonlySet<string> = new Set(["acknowledged", "confirmed"]);
/** States with a recorded outcome — a second ack is already_recorded or conflicting_ack. */
export const RESOLVED_COMMAND_STATES: ReadonlySet<string> = new Set(["acknowledged", "confirmed", "failed"]);
/** States where any late ack is evidence for humans only — never a transition. */
export const INACTIVE_COMMAND_STATES: ReadonlySet<string> = new Set([
  "timeout", "cancelled", "expired", "unknown_outcome", "requires_investigation",
]);
/** States a staff member may explicitly requeue (never automatic for physical commands). */
export const REQUEUEABLE_STATES: ReadonlySet<string> = new Set(["failed", "cancelled", "timeout", "expired"]);
/** Commands that physically actuate hardware — requeue requires explicit staff opt-in. */
export const PHYSICAL_COMMANDS: ReadonlySet<string> = new Set(["dispense", "return_slot", "unlock_slot"]);

/** Default ack window: commands unanswered this long are swept to unknown_outcome. */
export const DEFAULT_COMMAND_TTL_SECONDS = 600;
/** Legacy rows without expires_at: open commands older than this are swept too. */
const LEGACY_OPEN_TTL_MS = 24 * 3600_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const COMMAND_SELECT =
  "id,kiosk_id,command,idempotency_key,status,payload,created_at,resolved_at," +
  "expires_at,expected_response_types,resolved_outcome,last_transition_at,attempt_count";

export type CommandRow = {
  id: string; kiosk_id: string; command: string; idempotency_key: string;
  status: string; payload: Record<string, unknown> | null;
  created_at?: string | null; resolved_at?: string | null;
  expires_at?: string | null; expected_response_types?: string[] | null;
  resolved_outcome?: string | null; last_transition_at?: string | null;
  attempt_count?: number | null;
};

/** Legal state-machine edges. Identity transitions are allowed (idempotent writes). */
const COMMAND_TRANSITIONS: Record<string, readonly CommandStatus[]> = {
  queued: ["sent", "awaiting_ack", "failed", "cancelled", "timeout", "unknown_outcome", "expired", "requires_investigation"],
  sent: ["awaiting_ack", "acknowledged", "confirmed", "failed", "timeout", "cancelled", "unknown_outcome", "expired", "requires_investigation"],
  awaiting_ack: ["acknowledged", "confirmed", "failed", "timeout", "cancelled", "unknown_outcome", "expired", "requires_investigation"],
  acknowledged: ["requires_investigation"],
  confirmed: ["requires_investigation"],
  failed: ["queued", "requires_investigation"],
  timeout: ["queued", "requires_investigation", "unknown_outcome"],
  cancelled: ["queued", "requires_investigation"],
  expired: ["queued", "requires_investigation", "unknown_outcome"],
  // unknown_outcome / requires_investigation resolve only via human decision —
  // a late ack may be recorded as the outcome, but never re-opens the command
  // into sent/awaiting_ack automatically.
  unknown_outcome: ["acknowledged", "confirmed", "failed", "timeout", "cancelled", "requires_investigation"],
  requires_investigation: ["queued", "acknowledged", "confirmed", "failed", "timeout", "unknown_outcome", "cancelled", "expired"],
};

export function canTransitionCommand(from: string, to: CommandStatus): boolean {
  return from === to || (COMMAND_TRANSITIONS[from] ?? []).includes(to);
}

async function getCommand(
  db: SupabaseClient,
  ref: { id: string } | { idempotencyKey: string; kioskId?: string },
): Promise<CommandRow | null> {
  if ("id" in ref) {
    const { data } = await db.from("device_commands").select(COMMAND_SELECT).eq("id", ref.id).maybeSingle();
    return (data as CommandRow | null) ?? null;
  }
  let q = db.from("device_commands").select(COMMAND_SELECT).eq("idempotency_key", ref.idempotencyKey);
  if (ref.kioskId) q = q.eq("kiosk_id", ref.kioskId);
  const { data } = await q.maybeSingle();
  return (data as CommandRow | null) ?? null;
}

async function audit(db: SupabaseClient, action: string, kioskId: string, detail: Record<string, unknown>) {
  await db.from("audit_logs").insert({ actor: null, action, entity: "kiosk", entity_id: kioskId, detail });
}

/**
 * Queues a command. `idempotency_key` uniqueness makes re-submission a safe no-op
 * ({ duplicate: true }). `expectedResponseTypes` restricts which ack event types may
 * resolve this command (null/empty = any). `ttlSeconds` sets expires_at — past it
 * with no terminal ack, sweepStaleCommands moves the row to unknown_outcome.
 */
export async function queueCommand(
  db: SupabaseClient,
  c: {
    kioskId: string; command: KioskCommand; issuedBy: string | null;
    payload?: Record<string, unknown>; key?: string;
    expectedResponseTypes?: string[]; ttlSeconds?: number; now?: Date;
  },
) {
  const now = c.now ?? new Date();
  const ttl = c.ttlSeconds ?? DEFAULT_COMMAND_TTL_SECONDS;
  const idempotency_key = c.key ?? `${c.command}:${c.kioskId}:${now.getTime()}`;
  const issued = c.issuedBy && UUID_RE.test(c.issuedBy) ? c.issuedBy : null;
  const { data, error } = await db.from("device_commands")
    .insert({
      kiosk_id: c.kioskId, command: c.command, idempotency_key, issued_by: issued,
      payload: c.payload ?? null, status: "queued", attempt_count: 0,
      expected_response_types: c.expectedResponseTypes?.length ? c.expectedResponseTypes : null,
      expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
      last_transition_at: now.toISOString(),
    })
    .select("id,status").single();
  if (error?.code === "23505") return { duplicate: true as const }; // same key already queued — safe no-op
  if (error) throw new Error("command_queue_failed");
  return { duplicate: false as const, id: data.id as string, status: data.status as string };
}

/**
 * Guarded state-machine transition. Refuses illegal edges (returns
 * { ok:false, reason:"illegal_transition" }) rather than writing anyway.
 * `resolvedOutcome` records WHAT resolved the command ('acknowledged' | 'failed' |
 * 'timeout' | …) so a later contradictory ack can be flagged as conflicting_ack.
 */
export async function transitionCommand(
  db: SupabaseClient,
  ref: { id: string } | { idempotencyKey: string; kioskId?: string },
  to: CommandStatus,
  opts: { resolvedOutcome?: string | null; now?: Date } = {},
): Promise<{ ok: true; from: string } | { ok: false; reason: "not_found" | "illegal_transition"; from?: string }> {
  const cmd = await getCommand(db, ref);
  if (!cmd) return { ok: false, reason: "not_found" };
  const from = cmd.status; // capture before the write — callers may hold a live row ref
  if (!canTransitionCommand(from, to)) {
    return { ok: false, reason: "illegal_transition", from };
  }
  const nowIso = (opts.now ?? new Date()).toISOString();
  const open = OPEN_COMMAND_STATES.has(to);
  const patch: Record<string, unknown> = {
    status: to,
    last_transition_at: nowIso,
    resolved_at: open ? null : nowIso,
  };
  if (opts && "resolvedOutcome" in opts) patch.resolved_outcome = opts.resolvedOutcome ?? null;
  const { error } = await db.from("device_commands").update(patch).eq("id", cmd.id);
  if (error) throw new Error("command_transition_failed");
  return { ok: true, from };
}

/** Adapter picked the command up — queued → sent (or awaiting_ack when the device accepted it). */
export const markCommandSent = (db: SupabaseClient, id: string, now?: Date) =>
  transitionCommand(db, { id }, "sent", { now });
export const markCommandAwaitingAck = (db: SupabaseClient, id: string, now?: Date) =>
  transitionCommand(db, { id }, "awaiting_ack", { now });

/**
 * Staff-initiated requeue. HARD GUARDS:
 *  - only from failed | cancelled | timeout | expired — unknown_outcome and
 *    requires_investigation must be resolved by a human FIRST (reason
 *    "requires_investigation");
 *  - physical commands (dispense / return_slot / unlock_slot) additionally require
 *    opts.allowPhysical — a lost dispense ack must never auto-retry a bank release;
 *  - each attempt gets a NEW idempotency_key suffix so the device treats it as a
 *    fresh command (the old key stays dead — acks for it become unknown_command);
 *    correlation by command uuid still works.
 */
export async function requeueCommand(
  db: SupabaseClient,
  commandId: string,
  opts: { issuedBy?: string | null; allowPhysical?: boolean; ttlSeconds?: number; now?: Date } = {},
): Promise<
  | { ok: true; id: string; attempt: number }
  | { ok: false; reason: "not_found" | "physical_requires_review" | "requires_investigation" | "illegal_transition" | "idempotency_conflict"; from?: string; command?: string }
> {
  const cmd = await getCommand(db, { id: commandId });
  if (!cmd) return { ok: false, reason: "not_found" };
  if (PHYSICAL_COMMANDS.has(cmd.command) && !opts.allowPhysical) {
    return { ok: false, reason: "physical_requires_review", command: cmd.command };
  }
  if (!REQUEUEABLE_STATES.has(cmd.status)) {
    return {
      ok: false,
      reason: cmd.status === "unknown_outcome" || cmd.status === "requires_investigation"
        ? "requires_investigation" : "illegal_transition",
      from: cmd.status,
    };
  }
  const now = opts.now ?? new Date();
  const attempt = (cmd.attempt_count ?? 0) + 1;
  const ttl = opts.ttlSeconds ?? DEFAULT_COMMAND_TTL_SECONDS;
  const issued = opts.issuedBy && UUID_RE.test(opts.issuedBy) ? opts.issuedBy : null;
  const { error } = await db.from("device_commands").update({
    status: "queued",
    idempotency_key: `${cmd.idempotency_key}:r${attempt}`,
    attempt_count: attempt,
    resolved_at: null,
    resolved_outcome: null,
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    last_transition_at: now.toISOString(),
    ...(issued ? { issued_by: issued } : {}),
  }).eq("id", cmd.id);
  if (error?.code === "23505") return { ok: false, reason: "idempotency_conflict" };
  if (error) throw new Error("command_requeue_failed");
  await audit(db, "kiosk.command_requeued", cmd.kiosk_id, {
    command_id: cmd.id, command: cmd.command, attempt, from_status: cmd.status,
  });
  return { ok: true, id: cmd.id, attempt };
}

const payloadStr = (payload: Record<string, unknown> | null | undefined, key: string) =>
  typeof payload?.[key] === "string" ? (payload[key] as string) : null;

async function resolveRentalId(db: SupabaseClient, ref: string): Promise<string | null> {
  const { data: byId } = await db.from("rentals").select("id").eq("id", ref).maybeSingle();
  if (byId) return (byId as { id: string }).id;
  const { data: byRef } = await db.from("rentals").select("id").eq("reference", ref).maybeSingle();
  return (byRef as { id: string } | null)?.id ?? null;
}

/**
 * Timeout / unknown-outcome sweep. Commands whose expires_at has passed while still
 * open (queued | sent | awaiting_ack) move to `unknown_outcome` — NEVER `failed`:
 * a lost acknowledgement does not prove the hardware did not act. Each swept command
 * is audited; commands linked to a rental (payload.rental_id / rental_ref) also get
 * a rental_exceptions row of kind `command_timeout` for staff review.
 *
 * Legacy rows without expires_at: queued >24h → `expired` (never dispatched),
 * sent/awaiting_ack >24h → `unknown_outcome` (dispatched, ack lost).
 *
 * WIRING: not called by any route yet — invoke from the fleet sweep / cron path
 * (e.g. alongside expireStaleCommands in src/lib/fleet-sweep.ts, which the parent
 * agent owns).
 */
export async function sweepStaleCommands(
  db: SupabaseClient,
  now = new Date(),
): Promise<{ unknownOutcome: number; expired: number; exceptions: number; commandIds: string[] }> {
  const nowIso = now.toISOString();
  const result = { unknownOutcome: 0, expired: 0, exceptions: 0, commandIds: [] as string[] };

  const { data: due } = await db.from("device_commands")
    .select("id,kiosk_id,command,idempotency_key,status,payload,expires_at,created_at")
    .in("status", ["queued", "sent", "awaiting_ack"])
    .not("expires_at", "is", null)
    .lt("expires_at", nowIso);

  for (const c of (due ?? []) as CommandRow[]) {
    const { error } = await db.from("device_commands")
      .update({ status: "unknown_outcome", resolved_at: nowIso, last_transition_at: nowIso })
      .eq("id", c.id);
    if (error) throw new Error("command_sweep_failed");
    result.unknownOutcome += 1;
    result.commandIds.push(c.id);

    const rentalRef = payloadStr(c.payload, "rental_id") ?? payloadStr(c.payload, "rental_ref");
    const rentalId = rentalRef ? await resolveRentalId(db, rentalRef) : null;
    if (rentalRef) {
      await db.from("rental_exceptions").insert({
        rental_id: rentalId, kiosk_id: c.kiosk_id, kind: "command_timeout", status: "open",
        detail: {
          command_id: c.id, idempotency_key: c.idempotency_key, command: c.command,
          command_status: c.status, expires_at: c.expires_at ?? null,
          swept_at: nowIso, rental_ref: rentalRef,
        },
      });
      result.exceptions += 1;
    }
    await audit(db, "kiosk.command_unknown_outcome", c.kiosk_id, {
      command_id: c.id, command: c.command, idempotency_key: c.idempotency_key,
      from_status: c.status, expires_at: c.expires_at ?? null, rental_linked: Boolean(rentalRef),
    });
  }

  // Legacy rows predating expires_at (migration 0052): bound them by age instead.
  const legacyCutoff = new Date(now.getTime() - LEGACY_OPEN_TTL_MS).toISOString();
  const { data: legacy } = await db.from("device_commands")
    .select("id,kiosk_id,command,idempotency_key,status,payload")
    .in("status", ["queued", "sent", "awaiting_ack"])
    .is("expires_at", null)
    .lt("created_at", legacyCutoff);

  for (const c of (legacy ?? []) as CommandRow[]) {
    // queued = never handed to an adapter → expired; sent/awaiting_ack = dispatched,
    // ack lost → unknown_outcome (same honesty rule as the expires_at path).
    const to: CommandStatus = c.status === "queued" ? "expired" : "unknown_outcome";
    const { error } = await db.from("device_commands")
      .update({ status: to, resolved_at: nowIso, last_transition_at: nowIso })
      .eq("id", c.id);
    if (error) throw new Error("command_sweep_failed");
    if (to === "expired") result.expired += 1; else result.unknownOutcome += 1;
    result.commandIds.push(c.id);
    const rentalRef = payloadStr(c.payload, "rental_id") ?? payloadStr(c.payload, "rental_ref");
    if (rentalRef) {
      const rentalId = await resolveRentalId(db, rentalRef);
      await db.from("rental_exceptions").insert({
        rental_id: rentalId, kiosk_id: c.kiosk_id, kind: "command_timeout", status: "open",
        detail: {
          command_id: c.id, idempotency_key: c.idempotency_key, command: c.command,
          command_status: c.status, swept_at: nowIso, legacy_no_expiry: true, rental_ref: rentalRef,
        },
      });
      result.exceptions += 1;
    }
    await audit(db, "kiosk.command_unknown_outcome", c.kiosk_id, {
      command_id: c.id, command: c.command, idempotency_key: c.idempotency_key,
      from_status: c.status, resolved_to: to, legacy_no_expiry: true,
    });
  }

  return result;
}

/**
 * Expire commands that no adapter picked up within a day so the queue never silently
 * grows stale. Superseded by sweepStaleCommands for expires_at-aware rows; kept for
 * callers (fleet-sweep) that only need the legacy behaviour.
 */
export async function expireStaleCommands(db: SupabaseClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const { data } = await db.from("device_commands").update({ status: "expired", resolved_at: now.toISOString() })
    .eq("status", "queued").is("expires_at", null).lt("created_at", cutoff).select("id");
  return data?.length ?? 0;
}
