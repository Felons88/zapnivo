import { createHmac, timingSafeEqual } from "node:crypto";
import { baseDomain } from "../subdomains";

/**
 * Per-ticket reply tokens for inbound email threading.
 *
 * Outbound ticket emails set Reply-To to `support+<TICKET>-<token>@zapnivo.com`
 * (or `partners+...` for partner tickets). Gmail plus-addressing delivers it to
 * the base mailbox; when the message is forwarded to the inbound parser the
 * token survives in the To/Delivered-To header and proves the reply belongs to
 * that exact ticket + requester. The token is an HMAC of ticket number +
 * requester email + org — unguessable, no table needed, rotates with
 * HELPDESK_SECRET.
 */

const DEV_SECRET = "zapnivo-dev-only-access-secret";
const secret = () => process.env.HELPDESK_SECRET ?? (process.env.NODE_ENV === "production" ? null : DEV_SECRET);

export const replyToken = (number: string, email: string, orgId: string | null): string | null => {
  const key = secret();
  if (!key) return null;
  return createHmac("sha256", key).update(`${number}:${email.toLowerCase()}:${orgId ?? ""}`).digest("hex").slice(0, 20);
};

export const verifyReplyToken = (number: string, email: string, orgId: string | null, token: string): boolean => {
  const want = replyToken(number, email, orgId);
  if (!want || want.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(token));
};

/** Reply-To address for a ticket notification, or null when no secret is configured. */
export const ticketReplyAddress = (t: { number: string; email: string; orgId?: string | null; requesterType?: string }): string | null => {
  const token = replyToken(t.number, t.email, t.orgId ?? null);
  if (!token) return null;
  const prefix = t.requesterType === "partner" ? "partners" : "support";
  return `${prefix}+${t.number}-${token}@${baseDomain()}`;
};

export type PlusReply = { number: string; token: string; mailbox: "support" | "partners" };

const PLUS_RE = /^(support|partners)\+([A-Za-z]+-\d+)-([a-f0-9]{20})@/i;

/** Extracts ticket number + reply token from a To/Delivered-To header value. */
export const parsePlusReply = (header: string | null | undefined): PlusReply | null => {
  if (!header) return null;
  const addr = header.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? header.trim();
  const m = addr.toLowerCase().match(PLUS_RE);
  if (!m) return null;
  return { mailbox: m[1].toLowerCase() as PlusReply["mailbox"], number: m[2].toUpperCase(), token: m[3] };
};
