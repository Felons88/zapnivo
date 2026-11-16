/**
 * Sanitize the `?src=` attribution tag on public inquiry pages.
 * Accepts only lowercase slug-style tags (e.g. "industry_offices",
 * "vending_snacks") so the value can be persisted and grouped safely.
 */
export function leadSourceTag(raw: string | string[] | undefined, fallback: string): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return fallback;
  const tag = v.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 80);
  return /^[a-z]/.test(tag) ? tag : fallback;
}
