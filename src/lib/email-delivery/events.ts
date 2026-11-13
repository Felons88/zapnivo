import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Email delivery-event webhook — pure parsing/verification core (no DB, no
 * Next imports — unit-testable).
 *
 * Providers:
 *  - Resend is supported via svix-style signed webhooks. NOTE: this repo's
 *    mailer (src/lib/helpdesk/mailer.ts getMailer) prefers Brevo when
 *    BREVO_API_KEY is set and falls back to Resend — so BREVO is the primary
 *    transactional sender in a both-keys deployment, Resend otherwise.
 *  - Brevo transactional webhooks carry no signature; they are authenticated
 *    by a shared secret the operator configures (BREVO_WEBHOOK_SECRET) sent as
 *    the X-Zapnivo-Delivery-Key header or ?key= param.
 *
 * Resend webhook docs: https://resend.com/docs/dashboard/webhooks/introduction
 *   POST body: { type: "email.delivered"|"email.bounced"|"email.complained"|
 *     "email.delivery_delayed"|"email.sent"|"email.opened"|"email.clicked",
 *     created_at, data: { email_id, to[], from, subject, ... } }
 *   Headers: svix-id, svix-timestamp, svix-signature ("v1,<base64> ..."),
 *   secret env RESEND_WEBHOOK_SECRET = "whsec_<base64>".
 *
 * Brevo transactional webhook docs:
 *   https://developers.brevo.com/docs/transactional-webhooks
 *   POST body (single event object or array): { event, email, id|message-id,
 *     ts|date|created_at, ... } with event in request|delivered|deferred|
 *     soft_bounce|hard_bounce|blocked|invalid_email|spam|unsubscribed|error|
 *     opened|click|unique_opened|proxy_open.
 */

export const EMAIL_DELIVERY_PROVIDERS = ["brevo", "resend"] as const;
export type EmailDeliveryProvider = (typeof EMAIL_DELIVERY_PROVIDERS)[number];

export const EMAIL_DELIVERY_EVENT_TYPES = [
  "accepted",
  "delivered",
  "deferred",
  "soft_bounce",
  "hard_bounce",
  "complaint",
  "unsubscribe",
  "failed",
] as const;
export type EmailDeliveryEventType = (typeof EMAIL_DELIVERY_EVENT_TYPES)[number];

/** Event types that must suppress the subscriber (never on accepted/delivered). */
export const SUPPRESSING_EVENT_TYPES: readonly EmailDeliveryEventType[] = [
  "hard_bounce",
  "complaint",
  "unsubscribe",
];

export const isSuppressingEvent = (t: EmailDeliveryEventType) =>
  (SUPPRESSING_EVENT_TYPES as readonly string[]).includes(t);

/** sha256 of the normalized recipient address — the only recipient identifier stored. */
export const hashRecipientEmail = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Reduces an arbitrary provider payload to a small sanitized JSON object:
 *  - drops keys that carry message content, headers, addresses or secrets
 *  - redacts any email address embedded in a surviving string value
 *  - keeps only scalar values (strings ≤200 chars, numbers, booleans, null)
 *    plus one level of nested objects/arrays, bounded
 * The result NEVER contains a raw recipient address.
 */
export function sanitizeDeliveryPayload(input: unknown): Record<string, unknown> {
  const DROP_KEY = /content|body|html|subject|header|token|secret|passw|credential|api[-_]?key/i;
  const out: Record<string, unknown> = {};
  const scrubStr = (s: string) => s.replace(EMAIL_RE, "[email]").slice(0, 200);
  const walk = (v: unknown, depth: number): unknown => {
    if (v == null) return null;
    if (typeof v === "string") return scrubStr(v);
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (depth >= 2) return null;
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walk(x, depth + 1));
    if (typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 30)) {
        if (DROP_KEY.test(k)) continue;
        const w = walk(val, depth + 1);
        if (w !== undefined) o[k] = w;
      }
      return o;
    }
    return null;
  };
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [k, v] of Object.entries(input as Record<string, unknown>).slice(0, 40)) {
      if (DROP_KEY.test(k)) continue;
      const w = walk(v, 1);
      if (w !== undefined && w !== null) out[k] = w;
    }
  }
  return out;
}

/* ── Svix signature verification (Resend) ──────────────────────────────────── */

export const SVIX_TOLERANCE_MS = 5 * 60_000;

const b64decode = (s: string) => Buffer.from(s, "base64");
const b64encode = (b: Buffer) => b.toString("base64");

/**
 * Verifies a svix-signed webhook body. `secret` is the raw RESEND_WEBHOOK_SECRET
 * value ("whsec_" prefix optional — the remainder is base64 key material).
 * Signed content: `${svix-id}.${svix-timestamp}.${rawBody}` → HMAC-SHA256 →
 * base64, compared (timing-safe) against each "v1," entry in svix-signature.
 * Timestamp must be within `toleranceMs` of `now` (replay protection).
 */
export function verifySvixSignature(opts: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  secret: string;
  toleranceMs?: number;
  now?: number;
}): boolean {
  const { id, timestamp, signature, body, secret } = opts;
  if (!id || !timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.now ?? Date.now();
  if (Math.abs(now - ts * 1000) > (opts.toleranceMs ?? SVIX_TOLERANCE_MS)) return false;

  const keyMaterial = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: Buffer;
  try { key = b64decode(keyMaterial); } catch { return false; }
  if (!key.length) return false;

  const expected = b64encode(createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest());
  const provided = signature
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));
  if (!provided.length) return false;
  const exp = Buffer.from(expected);
  return provided.some((sig) => {
    const got = Buffer.from(sig);
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
}

/** Shared-secret check for unsigned providers (Brevo). Constant-time. */
export function verifySharedSecret(provided: string | null, secret: string): boolean {
  if (!provided || !secret) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── Provider payload normalization ────────────────────────────────────────── */

export type NormalizedDeliveryEvent = {
  provider: EmailDeliveryProvider;
  /** Idempotency key — unique per provider. */
  providerEventId: string;
  eventType: EmailDeliveryEventType;
  /** Raw recipient address — used ONLY in-memory to correlate; never stored. */
  recipientEmail: string;
  occurredAt: string; // ISO
  /** Sanitized provider payload (no content, no addresses). */
  payload: Record<string, unknown>;
};

const EMAIL_RE_SINGLE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const emailOf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = v.match(EMAIL_RE_SINGLE);
  return m ? m[0].toLowerCase() : null;
};

const toIso = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Brevo `ts` is epoch seconds; tolerate ms too.
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};

/** Fallback idempotency key when the provider omits an event id. */
const fallbackEventId = (_provider: EmailDeliveryProvider, raw: unknown) =>
  `body:${createHash("sha256").update(JSON.stringify(raw) ?? "").digest("hex").slice(0, 32)}`;

const RECIPIENT_KEYS = ["email", "to", "recipient", "address"] as const;

function pickRecipient(obj: Record<string, unknown>): string | null {
  for (const k of RECIPIENT_KEYS) {
    const v = obj[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        const e = typeof item === "string" ? emailOf(item) : emailOf((item as { email?: unknown })?.email);
        if (e) return e;
      }
    } else {
      const e = emailOf(v);
      if (e) return e;
    }
  }
  return null;
}

const RESEND_MAP: Record<string, EmailDeliveryEventType | "ignore"> = {
  "email.sent": "accepted",
  "email.delivered": "delivered",
  "email.delivery_delayed": "deferred",
  "email.complained": "complaint",
  "email.bounced": "hard_bounce", // refined below for transient bounces
  "email.failed": "failed",
  "email.opened": "ignore",
  "email.clicked": "ignore",
};

/**
 * Normalizes one Resend webhook event. Returns null for event types we do not
 * track (opened/clicked) or malformed payloads — the route answers 200 ignored.
 */
export function parseResendEvent(raw: unknown): NormalizedDeliveryEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  const type = typeof j.type === "string" ? j.type : "";
  const mapped = RESEND_MAP[type];
  if (!mapped || mapped === "ignore") return null;

  const data = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
  const recipient = pickRecipient(data) ?? pickRecipient(j);
  if (!recipient) return null;

  let eventType: EmailDeliveryEventType = mapped;
  if (type === "email.bounced") {
    // Resend includes bounce.type — "Transient"/"Temporary" must NOT suppress.
    const bounce = (data.bounce && typeof data.bounce === "object" ? data.bounce : {}) as Record<string, unknown>;
    const bt = String(bounce.type ?? bounce.subType ?? "").toLowerCase();
    if (/transient|temporary|soft/.test(bt)) eventType = "soft_bounce";
  }

  const providerEventId =
    (typeof data.email_id === "string" && data.email_id) ||
    (typeof j.id === "string" && j.id) ||
    fallbackEventId("resend", raw);

  return {
    provider: "resend",
    providerEventId: `resend:${providerEventId}`,
    eventType,
    recipientEmail: recipient,
    occurredAt: toIso(j.created_at) ?? new Date().toISOString(),
    payload: sanitizeDeliveryPayload(j),
  };
}

const BREVO_MAP: Record<string, EmailDeliveryEventType | "ignore"> = {
  request: "accepted",
  delivered: "delivered",
  deferred: "deferred",
  soft_bounce: "soft_bounce",
  hard_bounce: "hard_bounce",
  blocked: "failed",
  invalid_email: "failed",
  error: "failed",
  spam: "complaint",
  unsubscribed: "unsubscribe",
  opened: "ignore",
  click: "ignore",
  unique_opened: "ignore",
  proxy_open: "ignore",
};

/**
 * Normalizes one Brevo transactional webhook event object. Returns null for
 * untracked types or payloads without a recipient.
 */
export function parseBrevoEvent(raw: unknown): NormalizedDeliveryEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  const event = typeof j.event === "string" ? j.event : "";
  const mapped = BREVO_MAP[event];
  if (!mapped || mapped === "ignore") return null;

  const recipient = pickRecipient(j);
  if (!recipient) return null;

  // Brevo's `id`/`message-id` identifies the MESSAGE, not the event — several
  // distinct events (delivered, then hard_bounce) share it. Suffix the event
  // name so distinct events aren't collapsed by the idempotency key while
  // replays of the SAME event still dedupe.
  const brevoId =
    (typeof j.id === "string" || typeof j.id === "number" ? String(j.id) : "") ||
    (typeof j["message-id"] === "string" && j["message-id"]) ||
    fallbackEventId("brevo", raw);
  const providerEventId = `${brevoId}:${event}`;

  return {
    provider: "brevo",
    providerEventId: `brevo:${providerEventId}`,
    eventType: mapped,
    recipientEmail: recipient,
    occurredAt: toIso(j.ts ?? j.date ?? j.created_at) ?? new Date().toISOString(),
    payload: sanitizeDeliveryPayload(j),
  };
}

/**
 * Parses a webhook body into normalized events. Resend sends a single object;
 * Brevo may send one object or an array — both are handled here (bounded).
 * `provider` is whichever credential authenticated the request.
 */
export function parseDeliveryWebhook(provider: EmailDeliveryProvider, body: unknown): NormalizedDeliveryEvent[] {
  const items = Array.isArray(body) ? body.slice(0, 50) : [body];
  const out: NormalizedDeliveryEvent[] = [];
  for (const item of items) {
    const ev = provider === "resend" ? parseResendEvent(item) : parseBrevoEvent(item);
    if (ev) out.push(ev);
  }
  return out;
}
