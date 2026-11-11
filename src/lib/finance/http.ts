import { NextResponse } from "next/server";
import type { SessionUser } from "../auth";
import { getSessionUser, isStaff } from "../auth";
import { rateLimit } from "../rate-limit";

/** Same-origin check for state-changing requests (mirrors helpdesk/http). */
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || new URL(origin).host === req.headers.get("host");
}

export const fail = (status: number, error: string, extra: object = {}) =>
  NextResponse.json({ error, ...extra }, { status });

export const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

/**
 * Staff gate for finance investigation routes. Returns the session user or a
 * ready-to-return 403/429 response. Caller decides whether admin-only actions
 * (decide) need an extra role check.
 */
export async function staffGate(req: Request, scope: string, limit = 120): Promise<SessionUser | NextResponse> {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return fail(403, "Staff access required.");
  const rl = rateLimit(`${scope}:${user.id}:${clientIp(req)}`, limit, 60_000);
  if (!rl.ok) return fail(429, "Slow down a little.", { retryAfter: rl.retryAfter });
  return user;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  return (await req.json().catch(() => ({}))) as Record<string, unknown>;
}
