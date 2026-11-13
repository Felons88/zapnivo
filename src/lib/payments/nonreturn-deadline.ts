import type { SupabaseClient } from "@supabase/supabase-js";
import { PRICING_V1 } from "@/lib/pricing";
import { recordLog } from "@/lib/observability";

/**
 * Non-return deadline resolution for a rental.
 *
 * The deadline MUST come from the rental's locked `pricing_versions`
 * .non_return_after_hours — never a hardcoded constant — so a future pricing
 * version with different hours produces the correct deadline on BOTH dispense
 * paths: the staff "dispense" action (api/rentals/[id]) and the kiosk
 * dispense-ack (kiosk/lifecycle). Both call `nonReturnDeadlineIso` with the
 * server clock as the base.
 *
 * Fallback: PRICING_V1.nonReturnAfterHours when the rental/version row is
 * missing, the version is unapproved, or the hours value is unusable. A
 * missing pricing row must never block a verified dispense — the fallback is
 * logged so the drift is visible.
 */
export async function nonReturnDeadlineHours(db: SupabaseClient, rentalId: string): Promise<number> {
  try {
    const { data: rental } = await db.from("rentals").select("pricing_version").eq("id", rentalId).maybeSingle();
    const versionId = (rental as { pricing_version?: string | null } | null)?.pricing_version;
    if (!versionId) return PRICING_V1.nonReturnAfterHours;
    const { data: pv } = await db.from("pricing_versions")
      .select("approved,non_return_after_hours").eq("id", versionId).maybeSingle();
    const row = pv as { approved?: boolean; non_return_after_hours?: number | null } | null;
    const hours = row?.non_return_after_hours;
    if (row?.approved === true && typeof hours === "number" && Number.isFinite(hours) && hours > 0) {
      return hours;
    }
    recordLog("warning", "nonreturn_deadline_pricing_fallback", {
      service: "payments", route: "payments/nonreturn-deadline",
      attrs: { rentalId, pricingVersion: versionId, approved: row?.approved ?? null, hours: hours ?? null },
    });
  } catch (e) {
    recordLog("warning", "nonreturn_deadline_lookup_failed", {
      service: "payments", route: "payments/nonreturn-deadline",
      attrs: { rentalId, err: e instanceof Error ? e.message.slice(0, 120) : "unknown" },
    });
  }
  return PRICING_V1.nonReturnAfterHours;
}

/** ISO deadline `from + locked-version non_return_after_hours`. */
export async function nonReturnDeadlineIso(db: SupabaseClient, rentalId: string, from: Date): Promise<string> {
  const hours = await nonReturnDeadlineHours(db, rentalId);
  return new Date(from.getTime() + hours * 3600_000).toISOString();
}
