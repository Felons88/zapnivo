export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listFleetDevices } from "@/lib/system/kiosks";
import { CertificationConsole, type ConsoleRun, type ConsoleDevice } from "./CertificationConsole";

export const metadata: Metadata = { title: "Hardware certification" };

const RUN_SELECT = "id,device_id,tier,check_key,status,detail,actor_id,created_at,record_hash,prev_hash";

/**
 * Hardware certification console — records and displays certification runs
 * (migration 0051). Shows REAL rows only; empty state is honest. Simulated and
 * gateway-contract results are software-contract evidence and are NEVER
 * presented as physical hardware verification.
 */
export default async function CertificationPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");

  let runs: ConsoleRun[] = [];
  let devices: ConsoleDevice[] = [];
  let loadError: string | null = null;

  if (db) {
    const [{ devices: fleet, error: devErr }, { data: runRows, error: runErr }] = await Promise.all([
      listFleetDevices(db, { limit: 500 }),
      db.from("system_certification_runs").select(RUN_SELECT).order("created_at", { ascending: false }).limit(200),
    ]);
    if (devErr) loadError = devErr;
    if (runErr) loadError = loadError ? `${loadError}; ${runErr.message}` : runErr.message;
    devices = fleet.map((d) => ({
      id: d.id,
      label: d.device_uid ?? d.id.slice(0, 8),
      serial_number: d.serial_number,
      status: d.status,
    }));
    runs = ((runRows ?? []) as ConsoleRun[]);
  }

  return (
    <SystemGate perm="system.kiosks.view">
      <CertificationConsole
        devices={devices}
        runs={runs}
        canManage={canManage}
        backendConfigured={!!db}
        loadError={loadError}
      />
    </SystemGate>
  );
}
