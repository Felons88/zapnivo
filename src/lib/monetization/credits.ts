import type { SupabaseClient } from "@supabase/supabase-js";
import type { PricingVersion } from "@/lib/pricing";
import { recordLog } from "@/lib/observability";

/**
 * Credit application at rental checkout/settlement.
 *
 * At checkout we RESERVE eligible entitlement units against the rental
 * (reserve_entitlement RPC — atomic, idempotent per rental+grant). At settlement
 * we COMMIT only what the final charge actually used (commit_entitlement_partial)
 * and RELEASE the rest (release_rental_reservations). Cancellation/expiry releases
 * everything. Nothing is consumed without a committed settlement.
 *
 * Application order (deterministic): 'cent' credits → 'minute' credits →
 * 'rental' units (a free rental covers whatever remains). Minute credits convert
 * at additionalHourCents/60 using integer ceil math.
 */

export type ReservationRow = { id: string; grant_id: string; unit: "rental" | "minute" | "cent"; amount: number; status: string };

const log = (msg: string, attrs?: Record<string, unknown>) =>
  recordLog("info", msg, { service: "monetization", attrs });

const minuteCents = (minutes: number, pricing: PricingVersion) =>
  Math.ceil((minutes * pricing.additionalHourCents) / 60);

/** Spendable balance per unit for a profile (remaining - reserved, unexpired, active). */
export async function spendable(db: SupabaseClient, profileId: string) {
  const { data } = await db.from("entitlement_grants")
    .select("unit,remaining,reserved")
    .eq("profile_id", profileId).eq("status", "active");
  const out: Record<string, number> = { rental: 0, minute: 0, cent: 0 };
  for (const g of (data ?? []) as { unit: string; remaining: number; reserved: number }[]) {
    out[g.unit] = (out[g.unit] ?? 0) + Math.max(0, g.remaining - g.reserved);
  }
  return out as { rental: number; minute: number; cent: number };
}

/**
 * Reserve credits for a rental at checkout. Best-effort per unit — a failed
 * reserve never blocks others, and credit failure never blocks the rental.
 */
export async function reserveForRental(
  db: SupabaseClient, profileId: string, rentalId: string,
  opts: { holdCents: number; pricing: PricingVersion },
): Promise<string[]> {
  const bal = await spendable(db, profileId);
  const ids: string[] = [];
  const tryReserve = async (unit: "rental" | "minute" | "cent", amount: number) => {
    if (amount <= 0) return;
    const { data, error } = await db.rpc("reserve_entitlement", {
      p_profile: profileId, p_unit: unit, p_amount: amount, p_rental_id: rentalId,
    });
    if (error) { log("credit_reserve_failed", { unit, err: error.message.slice(0, 140) }); return; }
    if (data) ids.push(data as string);
  };
  // cent: up to the authorization hold (final charge is always <= hold).
  await tryReserve("cent", Math.min(bal.cent, opts.holdCents));
  // minute: enough minutes to cover the hold at the per-minute rate.
  const perMin = opts.pricing.additionalHourCents / 60;
  const minNeeded = perMin > 0 ? Math.ceil(opts.holdCents / perMin) : 0;
  await tryReserve("minute", Math.min(bal.minute, minNeeded));
  // rental: one free-rental unit covers the whole charge.
  await tryReserve("rental", Math.min(bal.rental, 1));
  if (ids.length) log("credits_reserved", { rental: rentalId.slice(0, 8), count: ids.length });
  return ids;
}

/** Open reservations for a rental. */
export async function openReservations(db: SupabaseClient, rentalId: string): Promise<ReservationRow[]> {
  const { data } = await db.from("entitlement_reservations")
    .select("id,grant_id,unit,amount,status").eq("rental_id", rentalId).eq("status", "reserved");
  return (data ?? []) as ReservationRow[];
}

type Commit =
  | { id: string; unit: "cent"; cents: number }
  | { id: string; unit: "minute"; cents: number; minutes: number }
  | { id: string; unit: "rental"; cents: number };

/**
 * Apply reserved credits to a final charge. Returns cents of credit applied.
 * Commits exactly `totalCents` worth in priority order (cent → minute → rental),
 * releases the remainder. Never throws — settlement must not fail on credits.
 */
export async function applyCreditsAtSettlement(
  db: SupabaseClient, rentalId: string, profileId: string | null,
  totalCents: number, pricing: PricingVersion, actor: string,
): Promise<number> {
  if (totalCents <= 0 || !profileId) {
    if (rentalId) await releaseForRental(db, rentalId);
    return 0;
  }
  const res = await openReservations(db, rentalId);
  if (!res.length) return 0;

  const plan: Commit[] = [];
  let remaining = totalCents;
  for (const unit of ["cent", "minute", "rental"] as const) {
    for (const r of res.filter((x) => x.unit === unit)) {
      if (remaining <= 0) break;
      if (unit === "rental") {
        plan.push({ id: r.id, unit, cents: remaining });
        remaining = 0;
      } else if (unit === "cent") {
        const take = Math.min(r.amount, remaining);
        plan.push({ id: r.id, unit, cents: take });
        remaining -= take;
      } else {
        // minute: consume whole minutes only; value = minuteCents(minutes)
        const minsAvail = r.amount;
        const minsNeeded = Math.ceil((remaining * 60) / pricing.additionalHourCents);
        const minsTake = Math.min(minsAvail, minsNeeded);
        const centsTake = Math.min(remaining, minuteCents(minsTake, pricing));
        plan.push({ id: r.id, unit, cents: centsTake, minutes: minsTake });
        remaining -= centsTake;
      }
    }
    if (remaining <= 0) break;
  }

  let applied = 0;
  for (const p of plan) {
    try {
      if (p.unit === "rental") {
        const { error } = await db.rpc("commit_entitlement", { p_reservation_id: p.id, p_actor: actor });
        if (!error) applied += p.cents;
        else log("credit_commit_failed", { unit: p.unit, err: error.message.slice(0, 140) });
      } else if (p.unit === "minute") {
        // Grant unit is minutes — commit whole minutes, value capped at cents.
        const mins = p.minutes;
        const { error } = await db.rpc("commit_entitlement_partial", { p_reservation_id: p.id, p_amount: mins, p_actor: actor });
        if (!error) applied += Math.min(p.cents, totalCents - applied);
        else log("credit_commit_failed", { unit: p.unit, err: error.message.slice(0, 140) });
      } else {
        const { error } = await db.rpc("commit_entitlement_partial", { p_reservation_id: p.id, p_amount: p.cents, p_actor: actor });
        if (!error) applied += p.cents;
        else log("credit_commit_failed", { unit: p.unit, err: error.message.slice(0, 140) });
      }
    } catch (e) {
      log("credit_commit_failed", { unit: p.unit, err: e instanceof Error ? e.message.slice(0, 140) : "unknown" });
    }
  }
  await releaseForRental(db, rentalId);
  if (applied > 0) log("credits_applied", { rental: rentalId.slice(0, 8), cents: applied });
  return Math.min(applied, totalCents);
}

/** Release all open reservations for a rental (cancel/expiry/no-credit paths). */
export async function releaseForRental(db: SupabaseClient, rentalId: string): Promise<number> {
  const { data, error } = await db.rpc("release_rental_reservations", { p_rental_id: rentalId });
  if (error) { log("credit_release_failed", { err: error.message.slice(0, 140) }); return 0; }
  return (data as number) ?? 0;
}

const TERMINAL_STATES = ["cancelled", "charged_off", "refunded"];

/**
 * Cron sweep: release reservations orphaned by rentals that reached a terminal
 * state without settlement (checkout rollback, cancellation, charge-off).
 * Idempotent — release_rental_reservations is a no-op when nothing is open.
 */
export async function releaseOrphanedReservations(db: SupabaseClient): Promise<number> {
  const { data: res } = await db.from("entitlement_reservations")
    .select("rental_id").eq("status", "reserved").not("rental_id", "is", null);
  const rentalIds = [...new Set(((res ?? []) as { rental_id: string }[]).map((r) => r.rental_id))];
  if (!rentalIds.length) return 0;
  const { data: rentals } = await db.from("rentals").select("id,state").in("id", rentalIds);
  const terminal = new Set(((rentals ?? []) as { id: string; state: string }[]).filter((r) => TERMINAL_STATES.includes(r.state)).map((r) => r.id));
  let released = 0;
  for (const rid of terminal) released += await releaseForRental(db, rid);
  if (released) log("orphaned_reservations_released", { count: released });
  return released;
}
