import { serviceClient } from "@/lib/supabase";
import { getMaintenanceNotice, type BannerSeverity } from "@/lib/system/emergency";

/**
 * PUBLIC reader for the maintenance notice — safe to call from public site
 * components. Returns the active notice only while the maintenance.notice
 * flag is enabled and unexpired; null otherwise (honest empty state).
 *
 * Cached ~30s per server instance so the public layout can call it on every
 * render without hammering the flags table. Server-only: uses the service
 * client; never expose secret material (the payload is just text/severity/TTL).
 *
 * NOTE: mounting a banner in src/app/(site)/layout.tsx is intentionally left
 * to the layout owner — call getPublicMaintenanceNotice() there and render a
 * dismissible strip when non-null.
 */

export type PublicMaintenanceNotice = {
  /** Notice text (≤280 chars, operator-supplied). */
  text: string;
  severity: BannerSeverity;
  /** ISO timestamp when the notice auto-expires. */
  expiresAt: string;
} | null;

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: PublicMaintenanceNotice } | null = null;

export async function getPublicMaintenanceNotice(nowMs = Date.now()): Promise<PublicMaintenanceNotice> {
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.value;
  const db = serviceClient();
  const notice = await getMaintenanceNotice(db, nowMs);
  const value: PublicMaintenanceNotice = notice
    ? { text: notice.message, severity: notice.severity, expiresAt: notice.expiresAt }
    : null;
  cache = { at: nowMs, value };
  return value;
}

/** Test hook — clears the module-level cache. */
export function resetMaintenanceNoticeCache(): void {
  cache = null;
}
