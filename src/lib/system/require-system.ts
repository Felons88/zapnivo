import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/dev-auth";
import { serviceClient } from "@/lib/supabase";
import { authorize, systemRole, type SystemAuthz, type SystemPermission, type SystemRole } from "./rbac";

// Kept OUT of rbac.ts on purpose: getSessionUser pulls node:crypto (auth.ts →
// notify → push/billing), and rbac is reachable from Edge instrumentation via
// observability → alert-notify → audit. Splitting keeps rbac edge-safe.

export type SystemContext = { ok: true; user: SessionUser; role: SystemRole; db: SupabaseClient };
export type SystemGuard = SystemContext | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Route/page guard: session → system_role → permission → service client.
 * `opts.user`/`opts.db` are injectable for tests; routes omit them.
 */
export async function requireSystem(
  perm: SystemPermission,
  opts: { db?: SupabaseClient | null; user?: SessionUser | null } = {},
): Promise<SystemGuard> {
  const { getSessionUser } = await import("@/lib/auth");
  const user = opts.user !== undefined ? opts.user : await getSessionUser();
  const db = opts.db !== undefined ? opts.db : serviceClient();
  if (!user) return { ok: false, status: 401, error: "Unauthenticated" };
  if (!db) return { ok: false, status: 503, error: "Backend not configured" };
  const role = await systemRole(user, db);
  const decision = authorize(user, role, perm);
  if (!decision.ok) return decision;
  return { ok: true, user: decision.user, role: decision.role, db };
}

/** Converts a failed SystemAuthz into a JSON response for API routes. */
export function systemAuthzResponse(fail: Extract<SystemAuthz, { ok: false }>): NextResponse {
  return NextResponse.json({ error: fail.error }, { status: fail.status });
}
