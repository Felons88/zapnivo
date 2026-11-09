/**
 * Best-effort in-memory limiter (per server instance). For multi-instance production,
 * back this with Upstash/Redis or a Supabase table; the interface is intentionally tiny.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > windowMs) hits.delete(k);
  return { ok: true, retryAfter: 0 };
}

export const resetRateLimits = () => hits.clear();
