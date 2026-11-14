export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import ReleasesPanel from "./ReleasesPanel";
import CampaignsPanel from "./CampaignsPanel";
import UpdateTargetsPanel from "./UpdateTargetsPanel";
import ConfigRolloutPanel from "./ConfigRolloutPanel";

export const metadata: Metadata = { title: "Kiosk updates — release management" };

/**
 * Remote update management (Phase 4.3). Registry + campaigns + per-device
 * state machines over migrations 0067 tables. Physical execution stays
 * disabled while KIOSK_ADAPTER=none — every dispatch path fails closed with
 * honest adapter_disabled states. Nothing on this page simulates hardware.
 */
export default async function KioskUpdatesPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-lime">Kiosk Infrastructure</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Update management</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Release registry, rollout campaigns and per-device update state for{" "}
            <code className="font-mono text-xs">system_devices</code>. Adapter:{" "}
            <code className="font-mono text-xs">{process.env.KIOSK_ADAPTER ?? "none"}</code> — physical
            update execution is disabled until a certified vendor adapter exists.{" "}
            <Link href="/system/kiosks" className="text-lime underline">← Fleet registry</Link>
          </p>
        </div>

        <ReleasesPanel db={db} canManage={canManage} />
        <CampaignsPanel db={db} canManage={canManage} />
        <UpdateTargetsPanel db={db} />
        <ConfigRolloutPanel db={db} canManage={canManage} />
      </div>
    </SystemGate>
  );
}
