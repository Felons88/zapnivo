import type { SupabaseClient } from "@supabase/supabase-js";
import { triggerRentalReturned, triggerRentalStarted } from "../email-triggers";
import { notifyReturnFailed } from "../notifications";
import { PRICING_V1 } from "../pricing";
import { assertTransition, type RentalState } from "../rental-state";
import { trackServer } from "../analytics";

/** Device event types that mean "a power bank was physically docked/returned". Vendor aliases land here. */
export const RETURN_EVENT_TYPES = new Set(["power_bank_docked", "bank_returned", "return_detected", "return_acknowledged"]);

/**
 * Phase 2.4 ack/failure event types — correlated against device_commands + rentals,
 * NEVER auto-settling. `return_detected` (sensor) and `return_acknowledged` (command
 * completion) live in RETURN_EVENT_TYPES instead: both are physical-truth return
 * signals and run the same bank↔rental verification before any state change.
 */
export const DISPENSE_CONFIRM_TYPES = new Set(["dispense_acknowledged", "bank_released"]);
export const DISPENSE_REQUEST_TYPES = new Set(["dispense_requested"]);
export const DISPENSE_FAIL_TYPES = new Set(["dispense_failed"]);
export const RETURN_FAIL_TYPES = new Set(["return_rejected"]);
export const FAULT_TYPES = new Set(["hardware_fault"]);
export const ACK_EVENT_TYPES = new Set([
  ...DISPENSE_CONFIRM_TYPES, ...DISPENSE_REQUEST_TYPES,
  ...DISPENSE_FAIL_TYPES, ...RETURN_FAIL_TYPES, ...FAULT_TYPES,
]);

/** Rental states a hardware-confirmed dispense may activate (mirrors the staff "dispense" action). */
const DISPENSEABLE_STATES = ["payment_authorized", "authorized", "dispense_pending"] as const;

/** Rental states a verified dock may complete. Terminal/fee states are left for admin review. */
export const RETURNABLE_STATES = ["active", "return_pending", "overdue", "unreturned"] as const;
const TERMINAL_STATES = ["returned", "closed", "cancelled", "charged_off", "disputed"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMAND_SELECT = "id,kiosk_id,command,idempotency_key,status,payload,created_at,resolved_at";

export type KioskEventInput = {
  /** Vendor-supplied event id — the replay-protection key. Null events are still processed once. */
  eventId: string | null;
  type: string;
  powerBankId?: string | null;
  /** Correlates to device_commands.id or .idempotency_key (Phase 2.4 ack contract). */
  commandId?: string | null;
  /** Rental UUID or public reference the ack claims to belong to. */
  rentalRef?: string | null;
  /** Device-reported ack classification (acknowledged|failed|rejected|detected|released). */
  ackOutcome?: string | null;
  errorCode?: string | null;
  /** Per-event hardware clock timestamp (ISO-8601). */
  hwTimestamp?: string | null;
  /** True when the event originates from a simulator/test harness — stored, never trusted as hardware truth. */
  simulated?: boolean | null;
  /** Kiosk-reported physical time (event `at`). Null → server UTC is authoritative. */
  deviceAt?: string | null;
  /** Ordering timestamp used for out-of-order detection (hw/device time ?? server receive time). */
  occurredAt: string;
  payload?: Record<string, unknown> | null;
};

export type KioskEventOutcome =
  | { result: "duplicate" }
  | { result: "heartbeat" | "ignored" | "out_of_order" | "already_returned" | "ack_recorded" | "already_recorded" | "unmatched" }
  | { result: "exception_raised"; kind: string }
  | { result: "returned" | "return_disputed"; rentalId: string }
  | { result: `rejected:${string}` };

export type KioskEventDeps = {
  notifyReturned?: (rentalId: string) => Promise<unknown>;
  /** Fired when a hardware-confirmed dispense activates a rental (mirrors the staff dispense action). */
  notifyStarted?: (rentalId: string) => Promise<unknown>;
};

type RentalRow = {
  id: string; state: string; power_bank_id: string | null; kiosk_id: string;
  non_return_deadline: string | null; returned_at: string | null;
};

type CommandRow = {
  id: string; kiosk_id: string; command: string; idempotency_key: string;
  status: string; payload: Record<string, unknown> | null;
};

const RENTAL_SELECT = "id,state,power_bank_id,kiosk_id,non_return_deadline,returned_at";

async function recordResult(db: SupabaseClient, rowId: string | null, result: string, nowIso: string) {
  if (rowId) await db.from("kiosk_events").update({ processed_at: nowIso, result }).eq("id", rowId);
}

const payloadStr = (payload: Record<string, unknown> | null | undefined, key: string) =>
  typeof payload?.[key] === "string" ? (payload[key] as string) : null;

/** Resolve the docked/dispensed bank: explicit id first, then payload id, then serial lookup. */
async function resolveBankId(db: SupabaseClient, ev: KioskEventInput): Promise<string | null> {
  let bankId = ev.powerBankId ?? null;
  const payloadBankId = payloadStr(ev.payload, "power_bank_id");
  const payloadSerial = payloadStr(ev.payload, "power_bank_serial");
  if (!bankId && payloadBankId) bankId = payloadBankId;
  if (!bankId && payloadSerial) {
    const { data: bank } = await db.from("power_banks").select("id").eq("serial", payloadSerial).maybeSingle();
    bankId = (bank as { id: string } | null)?.id ?? null;
  }
  return bankId;
}

/** Find a device_commands row by idempotency_key (text) or uuid id — scoped to this kiosk. */
async function findCommand(db: SupabaseClient, kioskId: string, commandId: string): Promise<CommandRow | null> {
  const { data: byKey } = await db.from("device_commands").select(COMMAND_SELECT)
    .eq("kiosk_id", kioskId).eq("idempotency_key", commandId).maybeSingle();
  let cmd = (byKey as CommandRow | null) ?? null;
  if (!cmd && UUID_RE.test(commandId)) {
    const { data: byId } = await db.from("device_commands").select(COMMAND_SELECT)
      .eq("kiosk_id", kioskId).eq("id", commandId).maybeSingle();
    cmd = (byId as CommandRow | null) ?? null;
  }
  return cmd;
}

/** Rental lookup by uuid id or public reference. eq("id") is attempted unconditionally:
 *  Postgres rejects non-uuid text on the uuid column (error → null), while the
 *  in-memory test harness and any legacy non-uuid ids still match directly. */
async function findRentalByRef(db: SupabaseClient, ref: string): Promise<RentalRow | null> {
  const { data: byId } = await db.from("rentals").select(RENTAL_SELECT).eq("id", ref).maybeSingle();
  let r = (byId as RentalRow | null) ?? null;
  if (r) return r;
  const { data: byRef } = await db.from("rentals").select(RENTAL_SELECT).eq("reference", ref).maybeSingle();
  r = (byRef as RentalRow | null) ?? null;
  if (!r && ref !== ref.toUpperCase()) {
    const { data: byRefUpper } = await db.from("rentals").select(RENTAL_SELECT).eq("reference", ref.toUpperCase()).maybeSingle();
    r = (byRefUpper as RentalRow | null) ?? null;
  }
  return r;
}

/** Latest rental (any state) holding this bank — used to detect mismatches honestly. */
async function findLatestRentalByBank(db: SupabaseClient, bankId: string): Promise<RentalRow | null> {
  const { data } = await db.from("rentals").select(RENTAL_SELECT)
    .eq("power_bank_id", bankId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data as RentalRow | null) ?? null;
}

/**
 * Raises a rental_exceptions investigation row (migration 0050) + audit event.
 * Chosen over fin_cases (finance-decision workflow, human approval semantics) and
 * incidents (service-level ops, no rental/kiosk FK granularity): an ack anomaly is
 * per-rental reconciliation state that staff resolve, not a money decision or outage.
 */
async function raiseException(
  db: SupabaseClient, kiosk: { id: string }, ev: KioskEventInput,
  kind: string, detail: Record<string, unknown>,
) {
  const rentalId = typeof detail.rental_id === "string" ? detail.rental_id : null;
  await db.from("rental_exceptions").insert({
    rental_id: rentalId, kiosk_id: kiosk.id, kind, status: "open",
    detail: {
      event_id: ev.eventId, event_type: ev.type, command_id: ev.commandId ?? null,
      rental_ref: ev.rentalRef ?? null, error_code: ev.errorCode ?? null,
      simulated: ev.simulated ?? null, occurred_at: ev.occurredAt, ...detail,
    },
  });
  await audit(db, "kiosk.exception_raised", "kiosk", kiosk.id, {
    kind, event_id: ev.eventId, type: ev.type, command_id: ev.commandId ?? null,
    rental_id: rentalId, occurred_at: ev.occurredAt,
  });
}

/**
 * Phase 2.4 ack handler. Correlates dispense/fault acknowledgements against
 * device_commands + rentals, records honest outcomes, and raises rental_exceptions
 * on ambiguity. NEVER settles, captures, or closes anything — settlement stays with
 * the verified return path (staff captureOnReturn) and verified returns only.
 */
async function handleDeviceAck(
  db: SupabaseClient, kiosk: { id: string }, ev: KioskEventInput,
  now: Date, nowIso: string, deps: KioskEventDeps,
  done: (o: KioskEventOutcome) => Promise<KioskEventOutcome>,
): Promise<KioskEventOutcome> {
  const commandId = ev.commandId ?? payloadStr(ev.payload, "command_id");
  const rentalRef = ev.rentalRef ?? payloadStr(ev.payload, "rental_ref") ?? payloadStr(ev.payload, "rental_id");
  const bankId = await resolveBankId(db, ev);

  // Nothing correlates this event to a command, rental or bank — logged, never acted on.
  if (!commandId && !rentalRef && !bankId) return done({ result: "unmatched" });

  // Command correlation: device_commands.id (uuid) or .idempotency_key (text).
  const command = commandId ? await findCommand(db, kiosk.id, commandId) : null;
  if (commandId && !command) {
    await raiseException(db, kiosk, ev, "unknown_command", { command_id: commandId });
    return done({ result: "exception_raised", kind: "unknown_command" });
  }
  // Idempotent command correlation: a second ack for an already-resolved command is a no-op.
  if (command && (command.status === "acknowledged" || command.status === "failed")) {
    return done({ result: "already_recorded" });
  }

  // Rental resolution: command payload hint > explicit rental_ref > bank→latest rental.
  // bankRental is fetched whenever a bank resolved so cross-source mismatches are caught.
  const cmdRentalRef = command ? payloadStr(command.payload, "rental_id") ?? payloadStr(command.payload, "rental_ref") : null;
  const [cmdRental, refRental, bankRental] = await Promise.all([
    cmdRentalRef ? findRentalByRef(db, cmdRentalRef) : Promise.resolve(null),
    rentalRef ? findRentalByRef(db, rentalRef) : Promise.resolve(null),
    bankId ? findLatestRentalByBank(db, bankId) : Promise.resolve(null),
  ]);
  const rental: RentalRow | null = cmdRental ?? refRental ?? bankRental;

  // Ambiguity checks — any contradiction raises an investigation, never a transition.
  if (cmdRental && refRental && cmdRental.id !== refRental.id) {
    await raiseException(db, kiosk, ev, "rental_ref_mismatch", {
      command_id: commandId, rental_id: refRental.id, command_rental_id: cmdRental.id,
    });
    return done({ result: "exception_raised", kind: "rental_ref_mismatch" });
  }
  // A bank whose LATEST rental is still open contradicts the acked rental. Terminal
  // rentals don't count — a finished rental frees the bank for a new dispense.
  if (rental && bankRental && bankRental.id !== rental.id && !TERMINAL_STATES.includes(bankRental.state)) {
    await raiseException(db, kiosk, ev, "bank_mismatch", {
      rental_id: rental.id, power_bank_id: bankId, bank_rental_id: bankRental.id, bank_rental_state: bankRental.state,
    });
    return done({ result: "exception_raised", kind: "bank_mismatch" });
  }
  if (rental && bankId && rental.power_bank_id && rental.power_bank_id !== bankId) {
    await raiseException(db, kiosk, ev, "bank_mismatch", {
      rental_id: rental.id, power_bank_id: bankId, rental_bank_id: rental.power_bank_id,
    });
    return done({ result: "exception_raised", kind: "bank_mismatch" });
  }
  if (!rental) {
    // Correlation existed (command and/or bank) but no rental resolves — investigate.
    await raiseException(db, kiosk, ev, "no_matching_rental", {
      command_id: commandId, power_bank_id: bankId,
    });
    return done({ result: "exception_raised", kind: "no_matching_rental" });
  }

  const positive = DISPENSE_CONFIRM_TYPES.has(ev.type);
  const failure = DISPENSE_FAIL_TYPES.has(ev.type) || RETURN_FAIL_TYPES.has(ev.type);

  // Command status reconciliation (idempotent — terminal states were handled above).
  if (command && (positive || failure)) {
    const status = positive ? "acknowledged" : "failed";
    await db.from("device_commands").update({ status, resolved_at: nowIso }).eq("id", command.id);
  }

  if (positive) {
    // Dispense confirmed by hardware: activate only from pre-dispense states.
    if ((DISPENSEABLE_STATES as readonly string[]).includes(rental.state)) {
      try {
        assertTransition(rental.state as RentalState, "active");
      } catch {
        await raiseException(db, kiosk, ev, "illegal_transition", { rental_id: rental.id, from: rental.state, to: "active" });
        return done({ result: "exception_raised", kind: "illegal_transition" });
      }
      // Hardware clock wins for dispensed_at; server UTC when absent. Deadline mirrors
      // the staff dispense action (PRICING_V1.nonReturnAfterHours from server now).
      const hwMs = ev.hwTimestamp ? Date.parse(ev.hwTimestamp) : NaN;
      const devMs = ev.deviceAt ? Date.parse(ev.deviceAt) : NaN;
      const dispensedAt = Number.isFinite(hwMs) ? new Date(hwMs).toISOString()
        : Number.isFinite(devMs) ? new Date(devMs).toISOString() : nowIso;
      const deadline = new Date(now.getTime() + PRICING_V1.nonReturnAfterHours * 3600_000).toISOString();
      const { error: upErr } = await db.from("rentals").update({
        state: "active", dispensed_at: dispensedAt, non_return_deadline: deadline,
        // Reconciliation: the hardware told us WHICH bank it released. Record it when the
        // rental doesn't already name one (mismatches were rejected above).
        ...(bankId && !rental.power_bank_id ? { power_bank_id: bankId } : {}),
      }).eq("id", rental.id);
      if (upErr) throw new Error("rental_dispense_update_failed");
      await audit(db, "kiosk.dispense_confirmed", "rental", rental.id, {
        kiosk_id: kiosk.id, event_id: ev.eventId, command_id: commandId ?? null,
        occurred_at: ev.occurredAt, dispensed_at: dispensedAt,
        ...(ev.simulated ? { simulated: true } : {}),
      });
      try {
        await (deps.notifyStarted ?? triggerRentalStarted)(rental.id);
      } catch { /* notification failure must not roll back a verified dispense */ }
      return done({ result: "ack_recorded" });
    }
    if (rental.state === "active") {
      // Already activated (e.g. staff confirmed earlier) — ack recorded, no transition.
      return done({ result: "ack_recorded" });
    }
    // Terminal/fee/overdue states: a dispense ack contradicts rental truth — investigate.
    await raiseException(db, kiosk, ev, "unexpected_rental_state", { rental_id: rental.id, state: rental.state });
    return done({ result: "exception_raised", kind: "unexpected_rental_state" });
  }

  // failure / requestOnly / fault: recorded honestly, no state change, no settlement.
  if (failure) {
    await audit(db, "kiosk.ack_failed", "rental", rental.id, {
      kiosk_id: kiosk.id, event_id: ev.eventId, type: ev.type, command_id: commandId ?? null,
      error_code: ev.errorCode ?? null, occurred_at: ev.occurredAt,
      ...(ev.simulated ? { simulated: true } : {}),
    });
  }
  return done({ result: "ack_recorded" });
}

/**
 * For return-type events carrying command_id (return_acknowledged = command completion):
 * a verified return marks the command acknowledged; an unknown command_id raises an
 * exception row WITHOUT changing the return outcome.
 */
async function reconcileReturnCommand(
  db: SupabaseClient, kiosk: { id: string }, ev: KioskEventInput, nowIso: string,
) {
  if (ev.type !== "return_acknowledged") return;
  const commandId = ev.commandId ?? payloadStr(ev.payload, "command_id");
  if (!commandId) return;
  const command = await findCommand(db, kiosk.id, commandId);
  if (!command) {
    await raiseException(db, kiosk, ev, "unknown_command", { command_id: commandId });
    return;
  }
  if (command.status !== "acknowledged" && command.status !== "failed") {
    await db.from("device_commands").update({ status: "acknowledged", resolved_at: nowIso }).eq("id", command.id);
  }
}

/**
 * Processes one authenticated device event against the rental state machine.
 * - Dedupes on event_id via kiosk_events (unique) — replays are safe no-ops.
 * - Rejects out-of-order returns (an older event arriving after a newer processed one).
 * - Verifies the docked bank matches the rental's assigned power_bank_id — never completes on mismatch.
 * - Post-deadline arrivals still mark the bank returned (physical truth) but flag return_disputed
 *   for admin review instead of letting any fee path fire automatically.
 * - Phase 2.4 ack types correlate to device_commands/rentals; ambiguity raises
 *   rental_exceptions. Acks NEVER settle, capture, or close rentals.
 */
export async function processKioskEvent(
  db: SupabaseClient,
  kiosk: { id: string },
  ev: KioskEventInput,
  now = new Date(),
  deps: KioskEventDeps = {},
): Promise<KioskEventOutcome> {
  const nowIso = now.toISOString();
  const isReturn = RETURN_EVENT_TYPES.has(ev.type);
  const isAck = ACK_EVENT_TYPES.has(ev.type);

  // Dedupe claim: kiosk_events.event_id is unique; a 23505 means this exact event was seen before.
  // Ack events always claim a row (even without event_id) so their outcome is recorded.
  let rowId: string | null = null;
  if (ev.eventId || isReturn || isAck) {
    const { data, error } = await db.from("kiosk_events")
      .insert({ event_id: ev.eventId, kiosk_id: kiosk.id, type: ev.type, payload: ev.payload ?? null, occurred_at: ev.occurredAt })
      .select("id").single();
    if (error?.code === "23505") return { result: "duplicate" };
    if (error) throw new Error("kiosk_event_insert_failed");
    rowId = (data as { id: string }).id;
  }
  const done = async (outcome: KioskEventOutcome): Promise<KioskEventOutcome> => {
    await recordResult(db, rowId, outcome.result, nowIso);
    return outcome;
  };

  if (ev.type === "heartbeat") return done({ result: "heartbeat" });
  if (isAck) return handleDeviceAck(db, kiosk, ev, now, nowIso, deps, done);
  if (!isReturn) return done({ result: "ignored" });

  // Replay/out-of-order: a newer event of the same type was already processed for this kiosk.
  const { data: newer } = await db.from("kiosk_events").select("id")
    .eq("kiosk_id", kiosk.id).eq("type", ev.type)
    .gt("occurred_at", ev.occurredAt).not("processed_at", "is", null).limit(1);
  if ((newer ?? []).length) return done({ result: "out_of_order" });

  // Resolve which power bank was docked (route passes the id; payload may carry id or serial).
  const bankId = await resolveBankId(db, ev);
  if (!bankId) return done({ result: "rejected:no_bank" });

  // Find the open rental this bank belongs to. Bank identity is authoritative — a rental may be
  // returned at any station, so we match on power_bank_id globally, not on kiosk_id.
  const rentalIdHint = payloadStr(ev.payload, "rental_id") ?? ev.rentalRef;
  let rental: RentalRow | null = null;
  let hintedRental: RentalRow | null = null;
  let reject: string | null = null;
  if (rentalIdHint) {
    const r = await findRentalByRef(db, rentalIdHint);
    if (r && (RETURNABLE_STATES as readonly string[]).includes(r.state)) hintedRental = r;
    if (!r || !(RETURNABLE_STATES as readonly string[]).includes(r.state)) reject = "rejected:no_open_rental";
    else if (r.power_bank_id !== bankId) reject = "rejected:wrong_bank";
    else rental = r;
  } else {
    const { data: byBank } = await db.from("rentals").select(RENTAL_SELECT)
      .eq("power_bank_id", bankId).in("state", [...RETURNABLE_STATES])
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    rental = (byBank as RentalRow | null) ?? null;
    if (!rental) {
      // Bank has no open rental — check whether this kiosk has open rentals expecting a DIFFERENT
      // bank (wrong-bank dock) vs. an already-finished rental for this bank (benign replay).
      const { data: finished } = await db.from("rentals").select("state")
        .eq("power_bank_id", bankId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const fState = (finished as { state: string } | null)?.state;
      if (fState && TERMINAL_STATES.includes(fState)) {
        await reconcileReturnCommand(db, kiosk, ev, nowIso);
        return done({ result: "already_returned" });
      }
      const { data: atKiosk } = await db.from("rentals").select("id")
        .eq("kiosk_id", kiosk.id).in("state", [...RETURNABLE_STATES]).limit(5);
      reject = (atKiosk ?? []).length ? "rejected:wrong_bank" : "rejected:unmatched_bank";
    }
  }

  if (reject) {
    await audit(db, "kiosk.event_rejected", rentalIdHint ? "rental" : "power_bank", rentalIdHint ?? bankId, {
      kiosk_id: kiosk.id, event_id: ev.eventId, type: ev.type, reason: reject, occurred_at: ev.occurredAt,
    });
    // A hinted rental docked with the wrong bank is a real failed return — tell that customer.
    if (reject === "rejected:wrong_bank" && hintedRental) {
      try { await notifyReturnFailed(hintedRental.id, db); } catch { /* best-effort */ }
    }
    return done({ result: reject as `rejected:${string}` });
  }
  if (!rental) return done({ result: "rejected:unmatched_bank" });

  try {
    assertTransition(rental.state as RentalState, "returned");
  } catch {
    await audit(db, "kiosk.event_rejected", "rental", rental.id, {
      kiosk_id: kiosk.id, event_id: ev.eventId, type: ev.type, reason: "illegal_transition", from: rental.state,
    });
    return done({ result: "rejected:illegal_transition" });
  }

  // Preserve the kiosk-reported physical dock time when present; otherwise server UTC is truth.
  const deviceMs = ev.deviceAt ? Date.parse(ev.deviceAt) : NaN;
  const returnedAt = Number.isFinite(deviceMs) ? new Date(deviceMs).toISOString() : nowIso;
  // A return that ARRIVED after the non-return deadline never auto-fees — flag for admin review.
  const deadlineMs = rental.non_return_deadline ? Date.parse(rental.non_return_deadline) : NaN;
  const late = Number.isFinite(deadlineMs) && now.getTime() > deadlineMs;

  const { error: upErr } = await db.from("rentals").update({
    state: "returned", returned_at: returnedAt, return_kiosk_id: kiosk.id,
    ...(late ? { return_disputed: true } : {}),
  }).eq("id", rental.id);
  if (upErr) throw new Error("rental_return_update_failed");

  await reconcileReturnCommand(db, kiosk, ev, nowIso);

  await audit(db, late ? "kiosk.return_disputed" : "kiosk.return_processed", "rental", rental.id, {
    kiosk_id: kiosk.id, event_id: ev.eventId, occurred_at: ev.occurredAt, returned_at: returnedAt,
    ...(late ? { non_return_deadline: rental.non_return_deadline } : {}),
  });
  trackServer({ name: "rental_completed", entityType: "rental", entityId: rental.id, props: { late } });

  try {
    await (deps.notifyReturned ?? triggerRentalReturned)(rental.id);
  } catch { /* notification failure must not roll back a verified physical return */ }

  return done(late ? { result: "return_disputed", rentalId: rental.id } : { result: "returned", rentalId: rental.id });
}

async function audit(db: SupabaseClient, action: string, entity: string, entityId: string, detail: Record<string, unknown>) {
  await db.from("audit_logs").insert({ actor: null, action, entity, entity_id: entityId, detail });
}
