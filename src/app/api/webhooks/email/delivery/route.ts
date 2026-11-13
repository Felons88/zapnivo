import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";
import { recordLog } from "@/lib/observability";
import {
  parseDeliveryWebhook,
  verifySharedSecret,
  verifySvixSignature,
  type EmailDeliveryProvider,
} from "@/lib/email-delivery/events";
import { recordDeliveryEvent } from "@/lib/newsletter/delivery-events";

/**
 * Provider delivery-event webhook — /api/webhooks/email/delivery
 *
 * Receives normalized delivery events (accepted/delivered/bounced/complaint/
 * unsubscribe/…) from the transactional email provider and feeds the honest
 * delivery ladder + newsletter suppression. Events are stored in
 * `email_delivery_events` (migration 0064); raw recipient addresses are NEVER
 * persisted — only subscriber_id + sha256 recipient_hash.
 *
 * ── Which provider is this for? ────────────────────────────────────────────
 * The mailer (src/lib/helpdesk/mailer.ts getMailer) prefers BREVO_API_KEY and
 * falls back to RESEND_API_KEY — Brevo is the primary transactional sender in
 * a both-keys deployment, Resend otherwise. This endpoint accepts EITHER,
 * authenticated by that provider's webhook secret:
 *
 *   Resend (primary when only RESEND_API_KEY is set):
 *     1. Resend dashboard → Webhooks → Add endpoint:
 *        URL  https://<host>/api/webhooks/email/delivery
 *        Events: email.sent, email.delivered, email.delivery_delayed,
 *                email.bounced, email.complained
 *     2. Copy the endpoint's Signing Secret → env RESEND_WEBHOOK_SECRET
 *        (format "whsec_…"). Requests are verified as svix signatures
 *        (svix-id / svix-timestamp / svix-signature headers, HMAC-SHA256,
 *        5-minute replay window).
 *
 *   Brevo (primary when BREVO_API_KEY is set):
 *     Brevo transactional webhooks cannot sign requests or set arbitrary
 *     headers, so auth is a shared secret:
 *     1. Brevo dashboard → Transactional → Settings → Webhooks → add the
 *        endpoint URL https://<host>/api/webhooks/email/delivery and select
 *        the events: delivered, hard_bounce, soft_bounce, blocked,
 *        invalid_email, deferred, spam, unsubscribed, error.
 *     2. Set env BREVO_WEBHOOK_SECRET to a random string, then configure the
 *        provider to send it — Brevo appends no secret itself, so in practice
 *        front the endpoint with a rule that injects the
 *        `X-Zapnivo-Delivery-Key: <secret>` header (or use ?key=<secret> on the
 *        configured URL — note query strings can leak into provider logs).
 *
 *   NO secret configured → 503. Unsigned/invalid → 401. We never process an
 *   unauthenticated event.
 *
 * Idempotency: (provider, provider_event_id) is unique — provider replays
 * return 200 {duplicate:true}. Single-row ops inline; we answer 200 fast.
 */

const MAX_BODY_BYTES = 100_000;

const resendSecret = () => process.env.RESEND_WEBHOOK_SECRET ?? "";
const brevoSecret = () => process.env.BREVO_WEBHOOK_SECRET ?? "";

/** Which provider credential authenticated this request, or null. */
function authenticate(req: Request, body: string): EmailDeliveryProvider | "unconfigured" | null {
  const svixId = req.headers.get("svix-id");
  const hasSvix = Boolean(svixId || req.headers.get("svix-timestamp") || req.headers.get("svix-signature"));
  const rSecret = resendSecret();
  const bSecret = brevoSecret();

  if (hasSvix) {
    if (!rSecret) return "unconfigured";
    const ok = verifySvixSignature({
      id: svixId,
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
      body,
      secret: rSecret,
    });
    return ok ? "resend" : null;
  }

  if (bSecret) {
    const keyHeader = req.headers.get("x-zapnivo-delivery-key") ?? "";
    const keyParam = new URL(req.url).searchParams.get("key") ?? "";
    if (verifySharedSecret(keyHeader, bSecret) || verifySharedSecret(keyParam, bSecret)) return "brevo";
    return null;
  }

  // No svix headers and no Brevo secret: if only Resend is configured this is
  // an unsigned/invalid request; if nothing is configured it's 503 upstream.
  return rSecret ? null : "unconfigured";
}

export async function POST(req: Request) {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  if (!body.trim()) return NextResponse.json({ error: "Empty payload" }, { status: 400 });

  const provider = authenticate(req, body);
  if (provider === "unconfigured") {
    return NextResponse.json({ error: "Email delivery webhooks not configured" }, { status: 503 });
  }
  if (!provider) {
    recordLog("warning", "email_delivery_webhook_auth_failed", { service: "email-delivery" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const events = parseDeliveryWebhook(provider, parsed);
  if (!events.length) {
    // Valid auth, untracked event type (opened/clicked) or malformed item —
    // acknowledge so the provider doesn't retry forever.
    return NextResponse.json({ ok: true, ignored: true });
  }

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  let processed = 0, duplicates = 0, suppressed = 0, failed = 0;
  for (const ev of events) {
    const res = await recordDeliveryEvent(db, ev);
    if (!res.ok) { failed++; continue; }
    if (res.duplicate) duplicates++;
    else { processed++; if (res.suppressed) suppressed++; }
  }

  if (failed > 0) {
    // Partial failure: ask the provider to retry — stored events dedupe on
    // redelivery via the (provider, provider_event_id) unique index.
    return NextResponse.json({ ok: false, error: "processing_failed", processed, duplicates, failed }, { status: 500 });
  }
  return NextResponse.json({ ok: true, processed, duplicates, suppressed });
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
