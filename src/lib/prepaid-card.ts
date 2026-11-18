import { createHmac, randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Zapnivo closed-loop prepaid card. Identity only — the balance is entitlement_grants.
 * The number uses a Zapnivo-only prefix that no card network issues, so it can never
 * be run as a Visa/Mastercard/etc. payment; it is only honored by Zapnivo machines.
 */

/** Federal gift-card rules (CARD Act) floor stored-value validity at five years. */
export const PREPAID_CARD_VALID_YEARS = 5;
const PAN_PREFIX = "9701";

export type PrepaidCard = { id: string; profile_id: string; pan: string; exp_month: number; exp_year: number; status: "active" | "frozen" | "expired"; issued_at: string };

const luhnCheckDigit = (partial: string) => {
  let sum = 0;
  for (let i = 0; i < partial.length; i++) {
    let d = Number(partial[partial.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
};

export const luhnValid = (pan: string) => /^\d{16}$/.test(pan) && luhnCheckDigit(pan.slice(0, 15)) === Number(pan[15]);

export function generatePan(): string {
  let body = PAN_PREFIX;
  while (body.length < 15) body += String(randomInt(0, 10));
  return body + luhnCheckDigit(body);
}

/** Expires at the end of the issue month, `years` out ("last day of the month"). */
export function expiryFor(issued: Date, years = PREPAID_CARD_VALID_YEARS) {
  return { month: issued.getUTCMonth() + 1, year: issued.getUTCFullYear() + years };
}

/** Last instant a card is valid: end of its expiry month. */
export const expiryEnd = (month: number, year: number) => new Date(Date.UTC(year, month, 1) - 1);
export const isExpired = (card: Pick<PrepaidCard, "exp_month" | "exp_year">, now = new Date()) => now > expiryEnd(card.exp_month, card.exp_year);

const secret = () => process.env.PREPAID_CARD_SECRET ?? process.env.HELPDESK_SECRET ?? (process.env.NODE_ENV === "production" ? null : "zapnivo-dev-only-prepaid-secret");

/** 3-digit security code derived from the card — recomputed on demand, never stored. */
export function cardCvc(card: Pick<PrepaidCard, "pan" | "exp_month" | "exp_year">): string | null {
  const key = secret();
  if (!key) return null;
  const mac = createHmac("sha256", key).update(`cvc:${card.pan}:${card.exp_month}:${card.exp_year}`).digest();
  return String(mac.readUInt32BE(0) % 1000).padStart(3, "0");
}

export const formatPan = (pan: string) => pan.replace(/(\d{4})(?=\d)/g, "$1 ");
export const maskedPan = (pan: string) => `•••• •••• •••• ${pan.slice(-4)}`;
export const formatExpiry = (c: Pick<PrepaidCard, "exp_month" | "exp_year">) => `${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year % 100).padStart(2, "0")}`;

const COLS = "id,profile_id,pan,exp_month,exp_year,status,issued_at";

/**
 * Returns the customer's live card, issuing one on first use and replacing an expired
 * one (the balance is unaffected). Safe under races: the partial unique index lets only
 * one active card per profile exist, and losers re-read the winner.
 */
export async function getOrIssueCard(db: SupabaseClient, profileId: string, now = new Date()): Promise<PrepaidCard | null> {
  if (!secret()) return null;
  const read = async () => {
    const { data } = await db.from("prepaid_cards").select(COLS).eq("profile_id", profileId).in("status", ["active", "frozen"]).maybeSingle();
    return (data as PrepaidCard | null) ?? null;
  };
  const current = await read();
  if (current && !isExpired(current, now)) return current;
  if (current) await db.from("prepaid_cards").update({ status: "expired", retired_at: now.toISOString() }).eq("id", current.id);

  const exp = expiryFor(now);
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await db.from("prepaid_cards").insert({ profile_id: profileId, pan: generatePan(), exp_month: exp.month, exp_year: exp.year }).select(COLS).single();
    if (!error && data) return data as PrepaidCard;
    const raced = await read();
    if (raced) return raced;
  }
  return null;
}
