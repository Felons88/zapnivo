import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring links that let a customer open ONE ticket thread without an account.
 * Token = base64url({ number, email, exp }) . HMAC-SHA256. Set HELPDESK_SECRET (32+ random bytes) in production.
 * Without it, production issues no tokens and customers must re-verify with ticket number + email.
 */
// Dev fallback must be a constant, not randomBytes: dev bundles are separate module
// instances (page vs API route), so a per-process value would differ between them.
const DEV_SECRET = "zapnivo-dev-only-access-secret";
const secret = () => process.env.HELPDESK_SECRET ?? (process.env.NODE_ENV === "production" ? null : DEV_SECRET);

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string, key: string) => createHmac("sha256", key).update(payload).digest("base64url");

export function signAccess(number: string, email: string, ttlSeconds = 7 * 86400, now = Date.now()): string | null {
  const key = secret();
  if (!key) return null;
  const payload = b64(JSON.stringify({ n: number, e: email.toLowerCase(), x: Math.floor(now / 1000) + ttlSeconds }));
  return `${payload}.${sign(payload, key)}`;
}

/** Returns the verified email for this ticket number, or null (bad signature, wrong ticket, expired). */
export function verifyAccess(token: string | undefined | null, number: string, now = Date.now()): string | null {
  const key = secret();
  if (!key || !token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload, key);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { n, e, x } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return n === number && typeof e === "string" && x * 1000 > now ? e : null;
  } catch { return null; }
}
