export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { firmwareInventory } from "@/lib/system/hardware";
import { DEVICE_STATUS_TONE } from "@/lib/system/kiosks";

export const metadata: Metadata = { title: "Firmware inventory" };

/**
 * Firmware inventory — real system_devices.firmware_version grouped counts.
 * There is NO artifact pipeline: firmware flashing requires verified vendor
 * packages and a hardware adapter (KIOSK_ADAPTER=none). This page reports
 * stored versions only and never claims an update capability.
 */
export default async function FirmwarePage() {
  const db = serviceClient();
  const { configured, groups, total } = await firmwareInventory(db);

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Kiosk Infrastructure</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Firmware inventory</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Reported <code className="font-mono text-xs">firmware_version</code> values across{" "}
            <code className="font-mono text-xs">system_devices</code> ({total} device{total === 1 ? "" : "s"}).{" "}
            <Link href="/system/kiosks" className="text-lime underline">← Fleet registry</Link>
          </p>
        </div>

        <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs text-amber-200">
          <strong>No artifact pipeline.</strong> Firmware flashing requires verified vendor packages and a live
          hardware adapter (<code className="font-mono">KIOSK_ADAPTER=none</code>). Versions below are stored
          device-reported values only — nothing here can push or verify an update.
        </div>

        {!configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — firmware inventory unavailable.
          </p>
        )}

        {configured && groups.length === 0 && (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10">
            <p className="text-sm text-slate-400">No devices registered — no firmware data to report.</p>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <section key={g.version} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-mono text-sm font-bold text-slate-200">{g.version}</h2>
                <span className="font-mono text-[11px] text-slate-400">{g.count} device{g.count === 1 ? "" : "s"}</span>
              </div>
              <ul className="mt-3 space-y-1.5">
                {g.devices.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 border-b border-white/5 pb-1.5 text-xs last:border-0">
                    <Link href={`/system/kiosks/${d.id}`} className="font-mono text-slate-300 hover:text-lime">
                      {d.device_uid ?? d.id.slice(0, 8)}
                    </Link>
                    <span className="flex items-center gap-2">
                      <span className="text-slate-500">{[d.manufacturer, d.model].filter(Boolean).join(" ") || "—"}</span>
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${DEVICE_STATUS_TONE[d.status] ?? ""}`}>{d.status}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </SystemGate>
  );
}
