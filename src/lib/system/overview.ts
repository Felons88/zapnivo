import type { SupabaseClient } from "@supabase/supabase-js";
import { paymentReadiness, type PaymentReadiness } from "@/lib/payments/readiness";
import { listFeatureFlags, type FeatureFlag } from "./flags";
import type { ChangeRequestRow } from "./audit";

/**
 * Aggregates for the Command Center. Everything here is REAL data or an honest
 * "unknown" — no fabricated station counts, uptime, or revenue.
 */

export type DeviceStatusCounts = Record<string, number>;

export type SystemOverview = {
  configured: boolean;
  devices: {
    total: number | null;
    byStatus: DeviceStatusCounts;
    recent: { id: string; device_uid: string | null; serial_number: string | null; model: string | null; status: string; last_heartbeat_at: string | null }[];
  };
  changes: { pending: number | null; recent: ChangeRequestRow[] };
  flags: FeatureFlag[];
  audit: { recent: { id: string; actor_role: string | null; action: string; resource: string; created_at: string }[] };
  payments: PaymentReadiness | null;
  environment: string;
};

const env = () => process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";

async function countByStatus(db: SupabaseClient): Promise<{ total: number | null; byStatus: DeviceStatusCounts }> {
  const { data, error } = await db.from("system_devices").select("status");
  if (error) return { total: null, byStatus: {} };
  const rows = (data ?? []) as { status: string }[];
  const byStatus: DeviceStatusCounts = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return { total: rows.length, byStatus };
}

export async function getSystemOverview(db: SupabaseClient | null): Promise<SystemOverview> {
  const environment = env();
  if (!db) {
    return {
      configured: false, environment,
      devices: { total: null, byStatus: {}, recent: [] },
      changes: { pending: null, recent: [] },
      flags: [], audit: { recent: [] }, payments: null,
    };
  }
  const [devCounts, recentDevices, pendingRes, recentChanges, flags, auditRows, payments] = await Promise.all([
    countByStatus(db),
    db.from("system_devices")
      .select("id,device_uid,serial_number,model,status,last_heartbeat_at")
      .order("created_at", { ascending: false }).limit(10),
    db.from("system_change_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
    db.from("system_change_requests")
      .select("id,action,environment,risk,justification,status,requested_by,decided_by,decided_at,result,created_at")
      .order("created_at", { ascending: false }).limit(10),
    listFeatureFlags(db, "production"),
    db.from("system_audit_events")
      .select("id,actor_role,action,resource,created_at")
      .order("created_at", { ascending: false }).limit(8),
    paymentReadiness(db).catch(() => null),
  ]);
  return {
    configured: true,
    environment,
    devices: {
      total: devCounts.total,
      byStatus: devCounts.byStatus,
      recent: ((recentDevices.data ?? []) as SystemOverview["devices"]["recent"]),
    },
    changes: {
      pending: pendingRes.error ? null : (pendingRes.count ?? 0),
      recent: ((recentChanges.data ?? []) as ChangeRequestRow[]),
    },
    flags,
    audit: { recent: ((auditRows.data ?? []) as SystemOverview["audit"]["recent"]) },
    payments,
  };
}
