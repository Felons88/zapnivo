import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * SMS via Twilio's REST API (plain fetch, no SDK). Everything is logged to sms_messages so the
 * dashboard can show delivery state; nothing claims sent when Twilio wasn't configured.
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
 *
 * Consent model (see notifications.ts): `sms_consent` at checkout gates the scheduled
 * reminder/warning nudges. STOP/START keywords manage `sms_opt_outs`, which suppresses every
 * non-transactional send. TRANSACTIONAL_KINDS are receipts/notices of things that already
 * happened (fee charged, payment failed, ticket received, return failure) — per carrier
 * practice and the rental-terms consent wording they still send; STOP only stops the nudges.
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

/**
 * Template/job kinds that are transactional confirmations, not marketing nudges.
 * They bypass both the checkout sms_consent gate and the sms_opt_outs suppression.
 * The opt-out/resubscribe confirmations themselves are compliance messages and always send.
 */
export const TRANSACTIONAL_KINDS = new Set([
  "return_failed",
  "non_return_fee_charged",
  "payment_failed",
  "ticket_received",
  "opt_out_confirmation",
  "resubscribe_confirmation",
]);
export const isTransactionalKind = (kind: string | null | undefined) => !!kind && TRANSACTIONAL_KINDS.has(kind);

/** True when this E.164 phone has an active sms_opt_outs row. Missing table/env degrades to false. */
export async function isOptedOut(db: SupabaseClient | null, phone: string | null | undefined): Promise<boolean> {
  const to = normalizePhone(phone);
  if (!db || !to) return false;
  const { data } = await db.from("sms_opt_outs").select("phone").eq("phone", to).maybeSingle();
  return !!data;
}

const OPT_OUT_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const OPT_IN_WORDS = new Set(["start", "unstop"]);

/**
 * Detects carrier opt-out/opt-in keywords: the whole message or its leading word,
 * case-insensitive, punctuation stripped ("STOP", "stop.", "STOP please"). Mid-sentence
 * mentions ("please stop texting") intentionally do NOT match — only leading keywords.
 */
export function smsOptCommand(body: string | null | undefined): "opt_out" | "opt_in" | null {
  const clean = (body ?? "").trim().toLowerCase();
  if (!clean) return null;
  const words = clean.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  const whole = words.join("");
  const first = words[0] ?? "";
  if (OPT_OUT_WORDS.has(whole) || OPT_OUT_WORDS.has(first)) return "opt_out";
  if (OPT_IN_WORDS.has(whole) || OPT_IN_WORDS.has(first)) return "opt_in";
  return null;
}

export type SmsSendResult = { sent: boolean; reason?: "opted_out" | "unconfigured" | "error"; errorCode?: string };

/**
 * Sends a text, logging the attempt (including Twilio error_code/error_message on failure).
 * Non-transactional kinds are suppressed for phones with an sms_opt_outs row.
 * Never throws — SMS is best-effort alongside email.
 */
export async function sendSms(db: SupabaseClient | null, opts: { to: string; body: string; rentalId?: string | null; ticketId?: string | null; kind?: string | null }): Promise<SmsSendResult> {
  const to = normalizePhone(opts.to);
  const from = normalizePhone(process.env.TWILIO_FROM_NUMBER);
  if (!smsConfigured() || !to || !from) return { sent: false, reason: "unconfigured" };
  if (!isTransactionalKind(opts.kind) && (await isOptedOut(db, to))) return { sent: false, reason: "opted_out" };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: from, Body: opts.body }),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number | string; message?: string };
    const errorCode = res.ok || json.code == null ? null : String(json.code);
    const errorMessage = res.ok ? null : (json.message ?? "send failed").slice(0, 300);
    if (db) await db.from("sms_messages").insert({
      direction: "outbound", from_number: from, to_number: to, body: opts.body,
      status: res.ok ? (json.status ?? "sent") : "failed", provider_sid: json.sid ?? null,
      rental_id: opts.rentalId ?? null, ticket_id: opts.ticketId ?? null,
      error_code: errorCode, error_message: errorMessage,
    });
    return res.ok ? { sent: true } : { sent: false, reason: "error", errorCode: errorCode ?? undefined };
  } catch { return { sent: false, reason: "error" }; }
}

export const OPT_OUT_CONFIRMATION = "Zapnivo: You have been unsubscribed from Zapnivo texts. Reply START to resubscribe.";
export const RESUBSCRIBE_CONFIRMATION = "Zapnivo: You're resubscribed to Zapnivo texts. Reply STOP to opt out anytime.";
export const INBOUND_ACK = "Zapnivo: thanks for your message — the team has it. For faster help, open a request at support.zapnivo.com/new";

/**
 * Handles one verified inbound SMS: logs it, applies STOP/START to sms_opt_outs,
 * and sends exactly one confirmation per opt state change (never one per repeated STOP).
 * Non-keyword messages get the single auto-ack. Media messages are logged only.
 */
export async function handleInboundSms(db: SupabaseClient, msg: { from: string; to: string; body: string; sid?: string | null; hasMedia?: boolean }) {
  await db.from("sms_messages").insert({
    direction: "inbound", from_number: msg.from, to_number: msg.to, body: msg.body,
    status: "received", provider_sid: msg.sid ?? null,
  });
  const phone = normalizePhone(msg.from) ?? msg.from;
  const cmd = smsOptCommand(msg.body);

  if (cmd === "opt_out") {
    const already = await isOptedOut(db, phone);
    if (!already) {
      await db.from("sms_opt_outs").upsert(
        { phone, source: "inbound_sms", created_at: new Date().toISOString() },
        { onConflict: "phone" },
      );
      await sendSms(db, { to: msg.from, body: OPT_OUT_CONFIRMATION, kind: "opt_out_confirmation" });
    }
    return { action: "opted_out" as const, confirmed: !already };
  }

  if (cmd === "opt_in") {
    await db.from("sms_opt_outs").delete().eq("phone", phone);
    await sendSms(db, { to: msg.from, body: RESUBSCRIBE_CONFIRMATION, kind: "resubscribe_confirmation" });
    return { action: "opted_in" as const };
  }

  if (!msg.hasMedia) await sendSms(db, { to: msg.from, body: INBOUND_ACK });
  return { action: "logged" as const };
}
