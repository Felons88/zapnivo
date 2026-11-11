import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "@/lib/observability";

/**
 * Event charging programs — organizer-run events where attendees buy prepaid
 * event passes (Stripe Checkout → webhook stamps paid_at) and redeem a code
 * once, inside the event window, to receive 'rental' entitlement units they
 * spend through the NORMAL per-member checkout flow. No simultaneous
 * dispensing: redemption grants units; the holder still rents individually.
 */

export type EventStatus = "draft" | "active" | "paused" | "closed" | "cancelled";
export type PassStatus = "active" | "redeemed" | "expired" | "revoked";

export type EventRow = {
  id: string; organizer_id: string; name: string; venue_id: string | null;
  starts_at: string; ends_at: string; status: EventStatus;
  package_id: string | null; max_redemptions: number | null; price_cents: number | null;
  created_at: string;
};
export type EventPassRow = {
  id: string; event_id: string; holder_id: string | null; code_hash: string;
  units_granted: number; units_used: number; expires_at: string | null;
  status: PassStatus; paid_at: string | null; stripe_checkout_session_id: string | null;
  created_at: string;
};

export const EVENT_SELECT =
  "id,organizer_id,name,venue_id,starts_at,ends_at,status,package_id,max_redemptions,price_cents,created_at";
// code_hash is never selected for display lists — codes are shown once at issue time.
export const PASS_PUBLIC_SELECT =
  "id,event_id,holder_id,units_granted,units_used,expires_at,status,paid_at,stripe_checkout_session_id,created_at";

/** Legal status transitions. closed/cancelled are terminal. */
export const EVENT_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ["active", "cancelled"],
  active: ["paused", "closed", "cancelled"],
  paused: ["active", "closed", "cancelled"],
  closed: [],
  cancelled: [],
};

export function canTransitionEvent(from: EventStatus, to: EventStatus): boolean {
  return EVENT_TRANSITIONS[from]?.includes(to) ?? false;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Human-friendly pass code (XXXX-XXXX-XXXX) + its sha256 storage hash. */
export function newPassCode(): { code: string; hash: string } {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  const bytes = randomBytes(12);
  const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  return { code, hash: sha256(code) };
}

export function hashPassCode(code: string): string {
  return sha256(code.trim().toUpperCase());
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number };
const fail = (error: string, status = 400): Result<never> => ({ ok: false, error, status });
const log = (level: "info" | "warning" | "error", message: string, attrs?: Record<string, unknown>) =>
  recordLog(level, message, { service: "events", attrs });

const iso = (v: string) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export type EventInput = {
  name: string; venueId?: string | null; startsAt: string; endsAt: string;
  maxRedemptions?: number | null; packageId?: string | null; priceCents?: number | null;
};

function validateWindow(startsAt: string, endsAt: string): Result<null> {
  const s = iso(startsAt), e = iso(endsAt);
  if (!s || !e) return fail("Enter valid start and end times.", 422);
  if (Date.parse(e) <= Date.parse(s)) return fail("End time must be after the start time.", 422);
  if (Date.parse(e) - Date.parse(s) > 366 * 86400_000) return fail("Events can't span more than a year.", 422);
  return { ok: true, data: null };
}

function cleanInput(input: EventInput) {
  return {
    name: input.name.trim().slice(0, 120),
    venue_id: input.venueId ?? null,
    starts_at: iso(input.startsAt)!,
    ends_at: iso(input.endsAt)!,
    max_redemptions: input.maxRedemptions && input.maxRedemptions > 0 ? Math.floor(input.maxRedemptions) : null,
    package_id: input.packageId ?? null,
    price_cents: input.priceCents && input.priceCents > 0 ? Math.floor(input.priceCents) : null,
  };
}

/** Creates an event in 'draft'. Organizer-scoped. */
export async function createEvent(db: SupabaseClient, organizerId: string, input: EventInput): Promise<Result<EventRow>> {
  const name = input.name.trim();
  if (!name) return fail("Event name is required.", 422);
  const w = validateWindow(input.startsAt, input.endsAt);
  if (!w.ok) return w;
  if (input.priceCents != null && (!Number.isInteger(input.priceCents) || input.priceCents <= 0)) {
    return fail("Price must be a positive whole number of cents.", 422);
  }
  const { data, error } = await db.from("event_programs")
    .insert({ organizer_id: organizerId, ...cleanInput({ ...input, name }) })
    .select(EVENT_SELECT).single();
  if (error || !data) { log("error", "event_create_failed", { err: error?.message?.slice(0, 160) }); return fail("Couldn't create the event.", 500); }
  log("info", "event_created", { event: (data as EventRow).id.slice(0, 8) });
  return { ok: true, data: data as EventRow };
}

export async function listEvents(db: SupabaseClient, organizerId: string): Promise<EventRow[]> {
  const { data, error } = await db.from("event_programs").select(EVENT_SELECT)
    .eq("organizer_id", organizerId).order("starts_at", { ascending: false }).limit(100);
  if (error) { log("warning", "event_list_failed", { err: error.message.slice(0, 160) }); return []; }
  return (data ?? []) as EventRow[];
}

export type PassStats = {
  total: number; active: number; redeemed: number; expired: number; revoked: number;
  paid: number; unitsGranted: number; unitsUsed: number;
};
export type EventDetail = { event: EventRow; stats: PassStats };

const emptyStats = (): PassStats => ({ total: 0, active: 0, redeemed: 0, expired: 0, revoked: 0, paid: 0, unitsGranted: 0, unitsUsed: 0 });

function tally(rows: { status: PassStatus; paid_at: string | null; units_granted: number; units_used: number }[]): PassStats {
  const s = emptyStats();
  for (const p of rows) {
    s.total += 1;
    s[p.status] += 1;
    if (p.paid_at) s.paid += 1;
    s.unitsGranted += p.units_granted;
    s.unitsUsed += p.units_used;
  }
  return s;
}

async function passRows(db: SupabaseClient, eventId: string) {
  const { data, error } = await db.from("event_passes").select(PASS_PUBLIC_SELECT).eq("event_id", eventId).limit(2000);
  if (error) { log("warning", "event_pass_stats_failed", { err: error.message.slice(0, 160) }); return null; }
  // Belt-and-braces: code_hash must never leave the server, even if the select string changes.
  return ((data ?? []) as unknown as (EventPassRow & { code_hash?: string })[]).map((r) => {
    const { code_hash: _hash, ...rest } = r;
    return rest as EventPassRow;
  });
}

/** Event detail for its organizer only, with pass + redemption stats. */
export async function getEvent(db: SupabaseClient, organizerId: string, eventId: string): Promise<Result<EventDetail>> {
  const { data: e } = await db.from("event_programs").select(EVENT_SELECT)
    .eq("id", eventId).eq("organizer_id", organizerId).maybeSingle();
  if (!e) return fail("Event not found.", 404);
  const rows = await passRows(db, eventId);
  if (!rows) return fail("Couldn't load pass stats.", 500);
  return { ok: true, data: { event: e as EventRow, stats: tally(rows) } };
}

/** Organizer-editable fields (never status — that goes through transitionEvent). */
export async function updateEvent(
  db: SupabaseClient, organizerId: string, eventId: string, patch: Partial<EventInput>,
): Promise<Result<EventRow>> {
  const { data: existing } = await db.from("event_programs").select(EVENT_SELECT)
    .eq("id", eventId).eq("organizer_id", organizerId).maybeSingle();
  if (!existing) return fail("Event not found.", 404);
  const cur = existing as EventRow;
  if (cur.status === "closed" || cur.status === "cancelled") return fail("This event is closed.", 409);

  const startsAt = patch.startsAt ?? cur.starts_at;
  const endsAt = patch.endsAt ?? cur.ends_at;
  const w = validateWindow(startsAt, endsAt);
  if (!w.ok) return w;
  if (patch.priceCents != null && (!Number.isInteger(patch.priceCents) || patch.priceCents <= 0)) {
    return fail("Price must be a positive whole number of cents.", 422);
  }
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const n = patch.name.trim().slice(0, 120);
    if (!n) return fail("Event name is required.", 422);
    update.name = n;
  }
  if (patch.venueId !== undefined) update.venue_id = patch.venueId || null;
  if (patch.startsAt !== undefined) update.starts_at = iso(patch.startsAt);
  if (patch.endsAt !== undefined) update.ends_at = iso(patch.endsAt);
  if (patch.maxRedemptions !== undefined) update.max_redemptions = patch.maxRedemptions && patch.maxRedemptions > 0 ? Math.floor(patch.maxRedemptions) : null;
  if (patch.packageId !== undefined) update.package_id = patch.packageId || null;
  if (patch.priceCents !== undefined) update.price_cents = patch.priceCents && patch.priceCents > 0 ? Math.floor(patch.priceCents) : null;
  if (Object.keys(update).length === 0) return fail("Nothing to update.", 422);

  const { data, error } = await db.from("event_programs").update(update)
    .eq("id", eventId).eq("organizer_id", organizerId)
    .select(EVENT_SELECT).single();
  if (error || !data) { log("warning", "event_update_failed", { err: error?.message?.slice(0, 160) }); return fail("Couldn't update the event.", 500); }
  log("info", "event_updated", { event: eventId.slice(0, 8) });
  return { ok: true, data: data as EventRow };
}

/**
 * Status transition. draft→active additionally requires the window to be sane
 * (start in the future or within a 15-minute grace, end after start).
 */
export async function transitionEvent(
  db: SupabaseClient, organizerId: string, eventId: string, to: EventStatus, nowMs = Date.now(),
): Promise<Result<EventRow>> {
  const { data: e } = await db.from("event_programs").select(EVENT_SELECT)
    .eq("id", eventId).eq("organizer_id", organizerId).maybeSingle();
  if (!e) return fail("Event not found.", 404);
  const cur = e as EventRow;
  if (!canTransitionEvent(cur.status, to)) {
    return fail(`Can't move an event from '${cur.status}' to '${to}'.`, 409);
  }
  if (to === "active") {
    const s = Date.parse(cur.starts_at), en = Date.parse(cur.ends_at);
    if (!Number.isFinite(s) || !Number.isFinite(en)) return fail("Event has an invalid time window.", 422);
    // First activation (draft→active) requires the event not to have already started;
    // resuming a paused event mid-window is allowed as long as it hasn't ended.
    if (cur.status === "draft" && s < nowMs - 15 * 60_000) {
      return fail("This event's start time has already passed — it can't be activated.", 409);
    }
    if (en <= nowMs) return fail("This event has already ended.", 409);
  }
  const { data, error } = await db.from("event_programs").update({ status: to })
    .eq("id", eventId).eq("organizer_id", organizerId).eq("status", cur.status)
    .select(EVENT_SELECT).maybeSingle();
  if (error || !data) { log("warning", "event_transition_failed", { err: error?.message?.slice(0, 160) }); return fail("Couldn't update the event status.", 500); }
  log("info", "event_transitioned", { event: eventId.slice(0, 8), from: cur.status, to });
  return { ok: true, data: data as EventRow };
}

/**
 * Issues a pass: creates an UNPAID event_passes row and returns the raw code
 * ONCE (only sha256 is stored). Enforces max_redemptions across non-revoked
 * passes. Passes are bearer instruments — holder_id is assigned at redeem.
 */
export async function issuePass(
  db: SupabaseClient, organizerId: string, eventId: string,
  input: { units: number; expiresAt?: string | null },
): Promise<Result<{ pass: EventPassRow; code: string }>> {
  const units = Math.floor(input.units);
  if (!Number.isFinite(units) || units < 1 || units > 100) return fail("Units must be between 1 and 100.", 422);
  let expiresAt: string | null = null;
  if (input.expiresAt) {
    expiresAt = iso(input.expiresAt);
    if (!expiresAt) return fail("Enter a valid expiry time.", 422);
  }
  const { data: e } = await db.from("event_programs").select(EVENT_SELECT)
    .eq("id", eventId).eq("organizer_id", organizerId).maybeSingle();
  if (!e) return fail("Event not found.", 404);
  const ev = e as EventRow;
  if (ev.status === "closed" || ev.status === "cancelled") return fail("This event is closed.", 409);
  const { code, hash } = newPassCode();
  // Atomic issue: advisory-locked cap check + insert in one transaction (0037).
  const { data: pid, error: rpcErr } = await db.rpc("issue_event_pass", {
    p_event: eventId, p_units: units, p_expires_at: expiresAt, p_code_hash: hash,
  });
  if (rpcErr) {
    const msg = rpcErr.message ?? "";
    if (msg.includes("cap_reached")) return fail("This event has reached its redemption cap.", 409);
    if (msg.includes("event_closed")) return fail("This event is closed.", 409);
    if (msg.includes("event_missing")) return fail("Event not found.", 404);
    log("warning", "pass_issue_failed", { err: msg.slice(0, 160) });
    return fail("Couldn't issue the pass.", 500);
  }
  const { data } = await db.from("event_passes").select("*").eq("id", pid as string).single();
  if (!data) return fail("Couldn't issue the pass.", 500);
  log("info", "pass_issued", { event: eventId.slice(0, 8), units });
  return { ok: true, data: { pass: data as EventPassRow, code } };
}

/** Pass list for an organizer's event — never includes code_hash. */
export async function listPasses(db: SupabaseClient, organizerId: string, eventId: string): Promise<Result<EventPassRow[]>> {
  const { data: e } = await db.from("event_programs").select("id").eq("id", eventId).eq("organizer_id", organizerId).maybeSingle();
  if (!e) return fail("Event not found.", 404);
  const rows = await passRows(db, eventId);
  if (!rows) return fail("Couldn't load passes.", 500);
  return { ok: true, data: rows };
}

/** Resolves the price for a pass checkout: event price_cents, else attached package price. */
export async function passPriceCents(db: SupabaseClient, passId: string): Promise<Result<{ priceCents: number; eventName: string }>> {
  const { data: p } = await db.from("event_passes").select("id,event_id,status,paid_at")
    .eq("id", passId).maybeSingle();
  if (!p) return fail("Pass not found.", 404);
  if ((p as { paid_at: string | null }).paid_at) return fail("This pass has already been paid.", 409);
  const { data: e } = await db.from("event_programs").select("id,name,status,price_cents,package_id,starts_at,ends_at")
    .eq("id", (p as { event_id: string }).event_id).maybeSingle();
  if (!e) return fail("Event not found.", 404);
  const ev = e as { name: string; status: EventStatus; price_cents: number | null; package_id: string | null };
  if (ev.status === "cancelled" || ev.status === "closed") return fail("This event is no longer on sale.", 409);
  let price = ev.price_cents;
  if (price == null && ev.package_id) {
    const { data: pkg } = await db.from("prepaid_packages").select("price_cents").eq("id", ev.package_id).maybeSingle();
    price = (pkg as { price_cents: number } | null)?.price_cents ?? null;
  }
  if (price == null || price <= 0) return fail("This pass isn't priced yet — ask the organizer.", 409);
  return { ok: true, data: { priceCents: price, eventName: ev.name } };
}

export type RedeemResult =
  | { ok: true; rentals: number }
  | { ok: false; error: string; status: number };

/** Coded exceptions raised by the redeem_event_pass RPC (migration 0034). */
const REDEEM_RPC_ERRORS: Record<string, { error: string; status: number }> = {
  invalid_code: { error: "invalid_code", status: 404 },
  unpaid: { error: "unpaid", status: 402 },
  revoked: { error: "revoked", status: 410 },
  already_redeemed: { error: "already_redeemed", status: 409 },
  expired: { error: "expired", status: 410 },
  exhausted: { error: "exhausted", status: 409 },
  event_missing: { error: "event_missing", status: 404 },
  event_inactive: { error: "event_inactive", status: 409 },
  outside_window: { error: "outside_window", status: 409 },
  unavailable: { error: "unavailable", status: 409 },
};

function mapRedeemRpcError(message: string | undefined): RedeemResult {
  const msg = message ?? "";
  for (const [code, mapped] of Object.entries(REDEEM_RPC_ERRORS)) {
    if (msg.includes(code)) return { ok: false, ...mapped };
  }
  return { ok: false, error: "redeem_failed", status: 500 };
}

/**
 * Redeems a pass code for the signed-in profile. All validation, the atomic
 * pass claim, the 'rental' entitlement grant, and the audit rows happen in a
 * single DB transaction via the redeem_event_pass RPC (migration 0034) — no
 * claim-then-compensate window exists. `nowMs` is retained for signature
 * compatibility; the RPC decides window/expiry against database time.
 */
export async function redeemPass(
  db: SupabaseClient, profileId: string, code: string, _nowMs = Date.now(),
): Promise<RedeemResult> {
  const raw = code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(raw)) return { ok: false, error: "invalid_code", status: 422 };

  const { data, error } = await db.rpc("redeem_event_pass", {
    p_code_hash: hashPassCode(raw),
    p_profile: profileId,
  });
  if (error) {
    const out = mapRedeemRpcError(error.message);
    if (!out.ok && out.status >= 500) {
      log("error", "pass_redeem_failed", { err: (error.message ?? "").slice(0, 160) });
    }
    return out;
  }
  const rentals = typeof data === "number" ? data : Number(data) || 0;
  log("info", "pass_redeemed", { rentals });
  return { ok: true, rentals };
}
