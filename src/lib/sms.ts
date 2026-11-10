import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * SMS via Twilio's REST API (plain fetch, no SDK). Everything is logged to sms_messages so the
 * dashboard can show delivery state; nothing claims sent when Twilio wasn't configured.
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
 */
export const smsConfigured = () =>
  Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);

/** Normalizes to E.164 — accepts +1..., or a bare 10-digit US number. Returns null otherwise. */
export function normalizePhone(v: string | null | undefined): string | null {
  const digits = (v ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if ((v ?? "").startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** Sends a text, logging the attempt. Never throws — SMS is best-effort alongside email. */
export async function sendSms(db: SupabaseClient | null, opts: { to: string; body: string; rentalId?: string | null; ticketId?: string | null }) {
  const to = normalizePhone(opts.to);
  const from = normalizePhone(process.env.TWILIO_FROM_NUMBER);
  if (!smsConfigured() || !to || !from) return { sent: false as const };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: from, Body: opts.body }),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string };
    if (db) await db.from("sms_messages").insert({ direction: "outbound", from_number: from, to_number: to, body: opts.body, status: res.ok ? (json.status ?? "sent") : "failed", provider_sid: json.sid ?? null, rental_id: opts.rentalId ?? null, ticket_id: opts.ticketId ?? null });
    return { sent: res.ok };
  } catch { return { sent: false as const }; }
}
