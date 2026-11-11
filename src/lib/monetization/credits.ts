import type { SupabaseClient } from "@supabase/supabase-js";
import type { PricingVersion } from "@/lib/pricing";
import { recordLog } from "@/lib/observability";
import { cancelPaymentIntent } from "@/lib/stripe";

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
  // No early return on empty reservations — the group pool spend below still
  // applies when the member has no personal credits reserved.

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
  if (res.length) {
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
  }

  // Group pool spend (last resort): whatever personal credits couldn't cover is
  // drawn from the member's first funded group pool via adjust_group_credit —
  // atomic row lock + negative-balance guard + entitlement_events audit. This
  // runs ONLY at settlement, so abandoned/cancelled rentals never debit the
  // pool. If the capture later fails the pool stays debited (same exposure as
  // committed credits) — flagged for reconciliation, never silently retried.
  const leftover = totalCents - applied;
  if (leftover > 0) {
    try {
      const pool = await fundedGroupPool(db, profileId);
      if (pool) {
        const spend = Math.min(leftover, pool.creditCents);
        const { data: bal, error } = await db.rpc("adjust_group_credit", {
          p_group: pool.groupId, p_delta: -spend,
          p_actor: "system:group_pool_spend",
          p_note: `Group pool spend — rental ${rentalId}`.slice(0, 300),
        });
        if (!error && typeof bal === "number") {
          applied += spend;
          log("group_pool_spent", { rental: rentalId.slice(0, 8), group: pool.groupId.slice(0, 8), cents: spend });
        } else if (error) {
          log("group_pool_spend_failed", { rental: rentalId.slice(0, 8), err: String((error as { message?: string }).message ?? error).slice(0, 140) });
        }
      }
    } catch (e) {
      log("group_pool_spend_failed", { rental: rentalId.slice(0, 8), err: e instanceof Error ? e.message.slice(0, 140) : "unknown" });
    }
  }

  if (applied > 0) log("credits_applied", { rental: rentalId.slice(0, 8), cents: applied });
  return Math.min(applied, totalCents);
}

/** First active group membership (deterministic) whose pool has credit. */
async function fundedGroupPool(db: SupabaseClient, profileId: string): Promise<{ groupId: string; creditCents: number } | null> {
  const { data: ms } = await db.from("rental_group_members")
    .select("group_id,created_at").eq("profile_id", profileId).eq("status", "active")
    .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(20);
  const ids = [...new Set(((ms ?? []) as { group_id: string }[]).map((m) => m.group_id))];
  if (!ids.length) return null;
  const { data: gs } = await db.from("rental_groups").select("id,credit_cents,status,created_at").in("id", ids);
  const funded = ((gs ?? []) as { id: string; credit_cents: number; status: string; created_at: string }[])
    .filter((g) => g.status === "active" && g.credit_cents > 0)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
  const g = funded[0];
  return g ? { groupId: g.id, creditCents: g.credit_cents } : null;
}

/** Release all open reservations for a rental (cancel/expiry/no-credit paths). */
export async function releaseForRental(db: SupabaseClient, rentalId: string): Promise<number> {
  const { data, error } = await db.rpc("release_rental_reservations", { p_rental_id: rentalId });
  if (error) { log("credit_release_failed", { err: error.message.slice(0, 140) }); return 0; }
  return (data as number) ?? 0;
}

// 'returned' is terminal for reservation purposes: settlement already ran
// releaseForRental, so anything still open is an orphan (e.g. captureOnReturn
// early-returned before applyCreditsAtSettlement when Stripe wasn't configured).
// ('refunded' isn't a rental_state enum value — kept for forward compatibility.)
const TERMINAL_STATES = ["cancelled", "charged_off", "refunded", "returned"];

const STALE_AUTHORIZED_MS = 2 * 3600_000;   // checkout abandoned before Stripe completion
const STALE_DISPENSE_MS = 24 * 3600_000;    // paid but never dispensed

/**
 * Cron sweep for rentals stuck mid-checkout:
 *  - state 'authorized' older than 2h → the customer never completed Stripe
 *    Checkout. Guarded flip to 'cancelled', open credit reservations released,
 *    authorized payments marked failed ('checkout_abandoned') and the Stripe
 *    hold cancelled best-effort.
 *  - state 'dispense_pending' older than 24h → paid but never dispensed; the
 *    rental stays open for staff, but credit reservations are released so they
 *    don't lock balances forever (settlement simply finds none open).
 * Idempotent: guarded state flips + release_rental_reservations no-ops.
 */
export async function expireStaleAuthorizedRentals(
  db: SupabaseClient,
): Promise<{ cancelled: number; released: number }> {
  const now = Date.now();
  let cancelled = 0;
  let released = 0;

  const authCutoff = new Date(now - STALE_AUTHORIZED_MS).toISOString();
  const { data: stale } = await db.from("rentals")
    .select("id").eq("state", "authorized").lt("created_at", authCutoff).limit(200);
  for (const r of (stale ?? []) as { id: string }[]) {
    const { data: moved } = await db.from("rentals")
      .update({ state: "cancelled" }).eq("id", r.id).eq("state", "authorized")
      .select("id").maybeSingle();
    if (!moved) continue; // raced with a real transition — leave it alone
    cancelled += 1;
    released += await releaseForRental(db, r.id);
    const { data: pays } = await db.from("payments")
      .select("id,stripe_payment_intent_id").eq("rental_id", r.id).eq("state", "authorized");
    for (const p of (pays ?? []) as { id: string; stripe_payment_intent_id: string | null }[]) {
      await db.from("payments").update({ state: "failed", failure_code: "checkout_abandoned" }).eq("id", p.id).eq("state", "authorized");
      if (p.stripe_payment_intent_id) {
        await cancelPaymentIntent(p.stripe_payment_intent_id, `abandon_${p.id}`).catch(() => null);
      }
    }
  }
  if (cancelled) log("stale_authorized_rentals_expired", { count: cancelled, released });

  const dispCutoff = new Date(now - STALE_DISPENSE_MS).toISOString();
  const { data: dispensing } = await db.from("rentals")
    .select("id").eq("state", "dispense_pending").lt("created_at", dispCutoff).limit(200);
  for (const r of (dispensing ?? []) as { id: string }[]) {
    released += await releaseForRental(db, r.id);
  }
  return { cancelled, released };
}

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
