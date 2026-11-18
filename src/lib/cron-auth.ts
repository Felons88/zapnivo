import { timingSafeEqual } from "node:crypto";
import { getSessionUser, isStaff } from "@/lib/auth";

/**
 * Shared auth for /api/cron/* routes.
 *
 * Accepted, in order:
 *  1. `Authorization: Bearer $CRON_SECRET` — Vercel cron sends this automatically.
 *  2. `Authorization: Bearer $WORKER_SECRET` — in-DB pg_cron drains (migration
 *     0089) and any external scheduler. Kept separate so rotating either
 *     scheduler's credential never breaks the other.
 *  3. A signed-in staff session — powers "Run now" buttons in the portal.
 */
export async function cronAuthorized(req: Request): Promise<boolean> {
  const bearer = req.headers.get("authorization") ?? "";
  for (const secret of [process.env.CRON_SECRET, process.env.WORKER_SECRET]) {
    if (!secret) continue;
    const want = `Bearer ${secret}`;
    if (bearer.length === want.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(want))) return true;
  }
  return isStaff(await getSessionUser());
}
