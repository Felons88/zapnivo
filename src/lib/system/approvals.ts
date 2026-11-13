import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChangeRequestRow, ChangeRisk } from "./audit";

/**
 * Pending-approvals queue for /system/approvals.
 *
 * This is a focused VIEW over system_change_requests — the full queue with
 * all statuses and history lives at /system/changes, and approve/reject still
 * goes through the existing POST /api/system/changes/[id]/decision route
 * (separation of duties enforced in decideChange). Nothing here mutates.
 */

export const APPROVAL_PAGE_SIZE = 100;

const SELECT =
  "id,action,environment,risk,justification,status,requested_by,decided_by,decided_at,result,created_at";

export type ApprovalQueueRow = ChangeRequestRow & {
  /** Age in whole hours since the request was created. */
  ageHours: number;
};

export type ApprovalSummary = {
  pending: number;
  byRisk: Record<ChangeRisk, number>;
  oldestPendingAt: string | null;
};

const RISKS: readonly ChangeRisk[] = ["low", "medium", "high", "critical"];

/** Pending change requests, oldest first — the queue a decider works through. */
export async function listPendingApprovals(
  db: SupabaseClient | null,
  opts: { limit?: number } = {},
): Promise<{ configured: boolean; rows: ApprovalQueueRow[] }> {
  if (!db) return { configured: false, rows: [] };
  const limit = Math.min(Math.max(opts.limit ?? APPROVAL_PAGE_SIZE, 1), 200);
  const { data, error } = await db
    .from("system_change_requests")
    .select(SELECT)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) return { configured: true, rows: [] };
  const now = Date.now();
  const rows = ((data ?? []) as ChangeRequestRow[]).map((r) => ({
    ...r,
    ageHours: Math.max(0, Math.floor((now - Date.parse(r.created_at)) / 3_600_000)),
  }));
  return { configured: true, rows };
}

/** Counts used for the queue header — pending total, per-risk split, oldest wait. */
export async function approvalSummary(db: SupabaseClient | null): Promise<ApprovalSummary | null> {
  if (!db) return null;
  const { data, error } = await db
    .from("system_change_requests")
    .select("risk,created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) return null;
  const rows = (data ?? []) as { risk: string; created_at: string }[];
  const byRisk: Record<ChangeRisk, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const r of rows) {
    const risk = (RISKS as readonly string[]).includes(r.risk) ? (r.risk as ChangeRisk) : "medium";
    byRisk[risk] += 1;
  }
  return { pending: rows.length, byRisk, oldestPendingAt: rows[0]?.created_at ?? null };
}
