import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rateLimit } from "@/lib/rate-limit";
import { requireSystem, systemAuthzResponse } from "@/lib/system/rbac";
import type { SessionUser } from "@/lib/auth";
import type { SystemPermission, SystemRole } from "@/lib/system/rbac";

export type ApiGuard =
  | { ok: true; user: SessionUser; role: SystemRole; db: SupabaseClient }
  | { ok: false; res: NextResponse };

/**
 * Shared guard for /api/system/* routes: session → system_role → permission →
 * service client, plus a per-user+permission rate limit. Mutating routes should
 * additionally call assertApprovedOrRequest (src/lib/system/audit.ts) — it
 * enforces the breakglass change-request rule and high/critical-risk approvals.
 */
export async function systemApiGuard(
  perm: SystemPermission,
  opts: { limit?: number; windowMs?: number } = {},
): Promise<ApiGuard> {
  const g = await requireSystem(perm);
  if (!g.ok) return { ok: false, res: systemAuthzResponse(g) };
  const rl = rateLimit(`system:${g.user.id}:${perm}`, opts.limit ?? 60, opts.windowMs ?? 60_000);
  if (!rl.ok) {
    return { ok: false, res: NextResponse.json({ error: "Rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfter) } }) };
  }
  return { ok: true, user: g.user, role: g.role, db: g.db };
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
