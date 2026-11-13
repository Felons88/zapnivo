export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getSystemDevice, isUuid, listFleetDevices } from "@/lib/system/kiosks";
import { computeOnboardingEvidence, type OnboardingEvidence } from "@/app/api/system/kiosks/onboarding/evidence";
import { OnboardingWizard, type WizardDeviceOption } from "./OnboardingWizard";

export const metadata: Metadata = {
  title: "Kiosk Infrastructure — Onboarding",
  robots: { index: false, follow: false },
};

/**
 * First-kiosk onboarding wizard (Phase 2.6). Server component loads the device
 * + all step evidence from real DB rows via computeOnboardingEvidence — the
 * same aggregator GET /api/system/kiosks/onboarding serves. Mutations happen
 * client-side against the EXISTING endpoints; nothing is fabricated and
 * hardware-dependent steps honestly show 'awaiting hardware'.
 */
export default async function KioskOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ device?: string }>;
}) {
  const { device: deviceParam } = await searchParams;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");

  let evidence: OnboardingEvidence | null = null;
  let deviceOptions: WizardDeviceOption[] = [];
  let venues: { id: string; label: string }[] = [];
  let loadError: string | null = null;

  if (db) {
    const [{ devices: fleet, error: fleetErr }, { data: venueRows }] = await Promise.all([
      listFleetDevices(db, { limit: 200 }),
      db.from("venues").select("id,name,city").order("name").limit(500),
    ]);
    if (fleetErr) loadError = fleetErr;
    deviceOptions = fleet.map((d) => ({
      id: d.id,
      label: `${d.device_uid ?? d.id.slice(0, 8)} — ${d.manufacturer ?? "?"} ${d.model ?? ""} (${d.status})`,
    }));
    venues = ((venueRows ?? []) as { id: string; name: string | null; city: string | null }[])
      .map((v) => ({ id: v.id, label: `${v.name ?? "Unnamed venue"}${v.city ? ` — ${v.city}` : ""}` }));

    if (deviceParam && isUuid(deviceParam)) {
      const device = await getSystemDevice(db, deviceParam);
      if (device) {
        evidence = await computeOnboardingEvidence(db, device);
      } else {
        loadError = "Device not found — pick another from the fleet or register a new kiosk.";
      }
    }
  }

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Kiosk Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">First-kiosk onboarding</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              13-step wizard driven by real evidence rows only. Steps that need physical hardware show{" "}
              <span className="text-amber-300">awaiting hardware</span> — simulated certification results are
              labeled and never count as physical verification. Mutations reuse the existing fleet APIs.
            </p>
          </div>
          <Link href="/system/kiosks" className="text-xs text-slate-400 underline hover:text-white">← Fleet registry</Link>
        </div>

        {!db && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — onboarding evidence unavailable.
          </p>
        )}
        {loadError && (
          <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{loadError}</p>
        )}

        <OnboardingWizard
          evidence={evidence}
          devices={deviceOptions}
          venues={venues}
          canManage={canManage}
          backendConfigured={!!db}
        />
      </div>
    </SystemGate>
  );
}
