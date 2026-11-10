import type { SupabaseClient } from "@supabase/supabase-js";
import { triggerRentalReturned } from "../email-triggers";
import { notifyReturnFailed } from "../notifications";
import { assertTransition, type RentalState } from "../rental-state";

/** Device event types that mean "a power bank was physically docked". Vendor aliases land here. */
export const RETURN_EVENT_TYPES = new Set(["power_bank_docked", "bank_returned"]);

/** Rental states a verified dock may complete. Terminal/fee states are left for admin review. */
export const RETURNABLE_STATES = ["active", "return_pending", "overdue", "unreturned"] as const;
const TERMINAL_STATES = ["returned", "closed", "cancelled", "charged_off", "disputed"];

export type KioskEventInput = {
  /** Vendor-supplied event id — the replay-protection key. Null events are still processed once. */
  eventId: string | null;
  type: string;
  powerBankId?: string | null;
  /** Kiosk-reported physical time (event `at`). Null → server UTC is authoritative. */
  deviceAt?: string | null;
  /** Ordering timestamp used for out-of-order detection (deviceAt ?? server receive time). */
  occurredAt: string;
  payload?: Record<string, unknown> | null;
};

export type KioskEventOutcome =
  | { result: "duplicate" }
  | { result: "heartbeat" | "ignored" | "out_of_order" | "already_returned" }
  | { result: "returned" | "return_disputed"; rentalId: string }
  | { result: `rejected:${string}` };

export type KioskEventDeps = { notifyReturned?: (rentalId: string) => Promise<unknown> };

type RentalRow = {
  id: string; state: string; power_bank_id: string | null; kiosk_id: string;
  non_return_deadline: string | null; returned_at: string | null;
};

const RENTAL_SELECT = "id,state,power_bank_id,kiosk_id,non_return_deadline,returned_at";

async function recordResult(db: SupabaseClient, rowId: string | null, result: string, nowIso: string) {
  if (rowId) await db.from("kiosk_events").update({ processed_at: nowIso, result }).eq("id", rowId);
}

/**
 * Processes one authenticated device event against the rental state machine.
 * - Dedupes on event_id via kiosk_events (unique) — replays are safe no-ops.
 * - Rejects out-of-order returns (an older event arriving after a newer processed one).
 * - Verifies the docked bank matches the rental's assigned power_bank_id — never completes on mismatch.
 * - Post-deadline arrivals still mark the bank returned (physical truth) but flag return_disputed
 *   for admin review instead of letting any fee path fire automatically.
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

  // Dedupe claim: kiosk_events.event_id is unique; a 23505 means this exact event was seen before.
  let rowId: string | null = null;
  if (ev.eventId || isReturn) {
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
  if (!isReturn) return done({ result: "ignored" });

  // Replay/out-of-order: a newer event of the same type was already processed for this kiosk.
  const { data: newer } = await db.from("kiosk_events").select("id")
    .eq("kiosk_id", kiosk.id).eq("type", ev.type)
    .gt("occurred_at", ev.occurredAt).not("processed_at", "is", null).limit(1);
  if ((newer ?? []).length) return done({ result: "out_of_order" });

  // Resolve which power bank was docked (route passes the id; payload may carry id or serial).
  let bankId = ev.powerBankId ?? null;
  const payloadBankId = typeof ev.payload?.power_bank_id === "string" ? ev.payload.power_bank_id : null;
  const payloadSerial = typeof ev.payload?.power_bank_serial === "string" ? ev.payload.power_bank_serial : null;
  if (!bankId && payloadBankId) bankId = payloadBankId;
  if (!bankId && payloadSerial) {
    const { data: bank } = await db.from("power_banks").select("id").eq("serial", payloadSerial).maybeSingle();
    bankId = (bank as { id: string } | null)?.id ?? null;
  }
  if (!bankId) return done({ result: "rejected:no_bank" });

  // Find the open rental this bank belongs to. Bank identity is authoritative — a rental may be
  // returned at any station, so we match on power_bank_id globally, not on kiosk_id.
  const rentalIdHint = typeof ev.payload?.rental_id === "string" ? ev.payload.rental_id : null;
  let rental: RentalRow | null = null;
  let hintedRental: RentalRow | null = null;
  let reject: string | null = null;
  if (rentalIdHint) {
    const { data } = await db.from("rentals").select(RENTAL_SELECT).eq("id", rentalIdHint).maybeSingle();
    const r = data as RentalRow | null;
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
      if (fState && TERMINAL_STATES.includes(fState)) return done({ result: "already_returned" });
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

  await audit(db, late ? "kiosk.return_disputed" : "kiosk.return_processed", "rental", rental.id, {
    kiosk_id: kiosk.id, event_id: ev.eventId, occurred_at: ev.occurredAt, returned_at: returnedAt,
    ...(late ? { non_return_deadline: rental.non_return_deadline } : {}),
  });

  try {
    await (deps.notifyReturned ?? triggerRentalReturned)(rental.id);
  } catch { /* notification failure must not roll back a verified physical return */ }

  return done(late ? { result: "return_disputed", rentalId: rental.id } : { result: "returned", rentalId: rental.id });
}

async function audit(db: SupabaseClient, action: string, entity: string, entityId: string, detail: Record<string, unknown>) {
  await db.from("audit_logs").insert({ actor: null, action, entity, entity_id: entityId, detail });
}
