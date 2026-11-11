import { sanitizeNextPath } from "./next-param";
import { homeFor } from "./customer";

/**
 * Post-auth `?next=` propagation helpers.
 *
 * Every sign-in path must funnel through the same rules:
 *  - the raw `next` value is ALWAYS run through sanitizeNextPath (same-origin
 *    absolute paths only — rejects //host, /api/*, backslashes, control chars,
 *    "://", >512 chars). Anything failing it is dropped, never redirected to.
 *  - when next is carried through OAuth/OTP, it rides as a `next` query param on
 *    the Supabase redirectTo URL (which GoTrue preserves when it appends its own
 *    code/token params). The single funnel is GET /api/auth/callback, which
 *    re-sanitizes before redirecting.
 */

/** Sanitized next or null. */
export const safeNext = (raw: string | null | undefined): string | null => sanitizeNextPath(raw);

/**
 * Append a sanitized `next` param to an absolute redirect URL (e.g. the
 * redirectTo passed to Supabase signInWithOAuth/signInWithOtp/generateLink).
 * Returns the URL unchanged when next is absent or unsafe.
 */
export function withNextParam(url: string, next: string | null | undefined): string {
  const safe = sanitizeNextPath(next);
  if (!safe) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("next", safe);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Where the auth callback should send the user: the sanitized `next` when present
 * and valid, otherwise the role-based home.
 */
export function postAuthDestination(
  next: string | null | undefined,
  role: string | null | undefined,
  opts?: { systemRole?: string | null; systemHost?: boolean },
): string {
  const safe = sanitizeNextPath(next);
  if (safe) return safe;
  // On the system console host, technical users land on /system instead of their
  // business role home (which would bounce them to internal.zapnivo.com).
  if (opts?.systemHost && opts.systemRole) return "/system";
  return homeFor(role);
}
