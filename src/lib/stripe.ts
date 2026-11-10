import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal Stripe REST client (no SDK). SERVER ONLY: never import from a client component.
 * Every call needs STRIPE_SECRET_KEY; callers must answer 503 payments_unconfigured when it is absent.
 */
export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);
export const taxEnabled = () => process.env.STRIPE_TAX_ENABLED === "1";

export const PAYMENTS_UNCONFIGURED = { error: "Payments are not available yet.", code: "payments_unconfigured" } as const;

/** Flattens nested objects/arrays into Stripe's form-encoding (a[b][0][c]=v). */
export function formEncode(input: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => {
      if (item !== null && typeof item === "object") out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`));
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
    });
    else if (typeof v === "object") out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export type StripeResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

export async function stripeCall<T = Record<string, unknown>>(
  method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string,
): Promise<StripeResult<T>> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { ok: false, status: 503, code: "payments_unconfigured", message: "Stripe is not configured." };
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let payload: string | undefined;
  if (body) { headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = formEncode(body).join("&"); }
  try {
    const res = await fetch(`https://api.stripe.com/v1${path}`, { method, headers, body: payload });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
    if (!res.ok) return { ok: false, status: res.status, code: json.error?.code ?? "stripe_error", message: (json.error?.message ?? "Stripe request failed").slice(0, 300) };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 502, code: "network_error", message: "Could not reach Stripe." };
  }
}

export type CheckoutInput = {
  rentalId: string; reference: string; holdCents: number; email: string; stationId: string; bankCount: number;
  successUrl: string; cancelUrl: string;
};

/** Checkout Session in payment mode with a manual-capture authorization hold. */
export function createCheckoutSession(i: CheckoutInput) {
  const body: Record<string, unknown> = {
    mode: "payment",
    customer_email: i.email,
    client_reference_id: i.rentalId,
    success_url: i.successUrl,
    cancel_url: i.cancelUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd", unit_amount: i.holdCents,
        product_data: { name: `Zapnivo power bank rental hold (${i.bankCount} bank${i.bankCount > 1 ? "s" : ""})`, description: "Authorization hold only. You are charged for the time used after you return the power bank; the remainder is released." },
        ...(taxEnabled() ? { tax_behavior: "exclusive" } : {}),
      },
    }],
    payment_intent_data: { capture_method: "manual", receipt_email: i.email, metadata: { rental_id: i.rentalId, rental_reference: i.reference } },
    metadata: { rental_id: i.rentalId, rental_reference: i.reference, station_id: i.stationId },
  };
  if (taxEnabled()) body.automatic_tax = { enabled: true };
  return stripeCall<{ id: string; url: string | null }>("POST", "/checkout/sessions", body, `checkout_${i.rentalId}`);
}

export const capturePaymentIntent = (pi: string, amountCents: number, idem: string) =>
  stripeCall<{ id: string; status: string; amount_received?: number }>("POST", `/payment_intents/${encodeURIComponent(pi)}/capture`, { amount_to_capture: amountCents }, idem);

export const cancelPaymentIntent = (pi: string, idem: string) =>
  stripeCall<{ id: string; status: string }>("POST", `/payment_intents/${encodeURIComponent(pi)}/cancel`, {}, idem);

export const createRefund = (pi: string, amountCents: number, idem: string, reason: string) =>
  stripeCall<{ id: string; status: string }>("POST", "/refunds", { payment_intent: pi, amount: amountCents, metadata: { reason: reason.slice(0, 200) } }, idem);

export const disputeUrl = (id: string) => `https://dashboard.stripe.com/${process.env.STRIPE_SECRET_KEY?.startsWith("sk_test") ? "test/" : ""}disputes/${encodeURIComponent(id)}`;

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/** Verifies a Stripe-Signature header: HMAC-SHA256 over `${t}.${payload}`, constant-time, 5 minute tolerance. */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, nowMs = Date.now(), toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS): SignatureCheck {
  if (!header) return { ok: false, reason: "missing" };
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") v1.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || v1.length === 0) return { ok: false, reason: "malformed" };
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return { ok: false, reason: "stale" };
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  const match = v1.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    return timingSafeEqual(Buffer.from(sig, "hex"), expected);
  });
  return match ? { ok: true } : { ok: false, reason: "mismatch" };
}
