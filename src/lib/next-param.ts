/**
 * Sanitizes a `?next=` post-login redirect target.
 *
 * Only same-origin absolute paths are allowed:
 * - must start with a single "/" (rejects "//evil.com" protocol-relative URLs)
 * - must not target /api/* (session-establishing endpoints aren't destinations)
 * - rejects backslashes, control characters, and embedded "://" so the value
 *   can never be coerced into an off-origin URL by the browser or router.
 *
 * Returns the sanitized path, or null when the value isn't safe to use.
 */
export function sanitizeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > 512) return null;
  if (!v.startsWith("/") || v.startsWith("//")) return null;
  if (v === "/api" || v.startsWith("/api/")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(v)) return null;
  if (v.includes("://")) return null;
  return v;
}
