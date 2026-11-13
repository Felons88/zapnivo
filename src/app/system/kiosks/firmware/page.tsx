export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { firmwareInventory } from "@/lib/system/hardware";
import { firmwareReadiness } from "@/lib/system/firmware-readiness";
import { DEVICE_STATUS_TONE } from "@/lib/system/kiosks";

export const metadata: Metadata = { title: "Firmware inventory" };

/**
 * Firmware inventory + rollout READINESS — real system_devices.firmware_version
 * grouped counts, per-model compatibility against system_hardware_profiles,
 * and an honest blocker list. There is NO artifact pipeline and no execution
 * path: firmware flashing requires verified vendor packages and a hardware
 * adapter (KIOSK_ADAPTER=none). This page reports stored state only and never
 * claims an update capability.
 */
export default async function FirmwarePage() {
  const db = serviceClient();
  const [{ configured, groups, total }, readiness] = await Promise.all([
    firmwareInventory(db),
    firmwareReadiness(db),
  ]);

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
          <strong>Rollout blocked: no vendor artifact/signing docs.</strong> Firmware flashing requires verified,
          signed vendor packages and a live hardware adapter (<code className="font-mono">KIOSK_ADAPTER={readiness.adapter}</code>).
          Versions below are stored device-reported values only — nothing here can push, stage, or verify an update.
          See <code className="font-mono">docs/GATEWAY-ADAPTER.md</code> for what vendor documentation must supply.
        </div>

        {!configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — firmware inventory unavailable.
          </p>
        )}

        {configured && readiness.rolloutBlockers.length > 0 && (
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Rollout readiness checklist</h2>
            <ul className="mt-3 space-y-1.5">
              {readiness.rolloutBlockers.map((b) => (
                <li key={b} className="flex items-start gap-2 text-xs text-slate-300">
                  <span className="mt-0.5 font-mono text-amber-300">✕</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[10px] text-slate-500">
              Blockers are derived from stored state only (adapter selection, certified profiles, capability
              claims). Clearing them still requires vendor documentation + certification — no execution path exists.
            </p>
          </section>
        )}

        {configured && readiness.models.length > 0 && (
          <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Per-model compatibility</h2>
            <p className="mt-1 text-[11px] text-slate-500">
              Devices grouped by manufacturer+model against <code className="font-mono">system_hardware_profiles</code>{" "}
              capability/certification claims. Canary selection info only — no rollout can be scheduled.
            </p>
            <table className="mt-3 w-full min-w-[720px] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Model", "Profile", "Cert", "FW update", "Versions", "Devices", "Docs", "Gateway spec"].map((h) => (
                  <th key={h} className="pb-2 pr-3 font-extrabold">{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {readiness.models.map((m) => {
                  const check = (ok: boolean) => (
                    <span className={`font-mono text-[11px] font-bold ${ok ? "text-lime" : "text-slate-500"}`}>{ok ? "yes" : "no"}</span>
                  );
                  return (
                    <tr key={`${m.manufacturer}|${m.model}`} className="border-t border-white/5 align-top">
                      <td className="py-2 pr-3">
                        <div className="font-mono font-bold text-slate-200">{m.model}</div>
                        <div className="text-[10px] text-slate-500">{m.manufacturer}</div>
                      </td>
                      <td className="py-2 pr-3 text-slate-300">{m.profile ? "profiled" : <span className="text-amber-300">unprofiled</span>}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${
                          m.certification === "certified" ? "bg-lime/15 text-lime ring-lime/30"
                          : m.certification === "no_profile" ? "bg-white/5 text-slate-500 ring-white/10"
                          : "bg-amber-400/15 text-amber-300 ring-amber-400/30"}`}>{m.certification}</span>
                      </td>
                      <td className="py-2 pr-3">{check(m.profile?.firmware_update === true)}</td>
                      <td className="py-2 pr-3 font-mono text-slate-400">{m.firmwareVersions.join(", ")}</td>
                      <td className="py-2 pr-3 font-mono text-slate-300">{m.deviceCount}</td>
                      <td className="py-2 pr-3">{check(!!m.profile?.protocol_doc_url)}</td>
                      <td className="py-2 pr-3">{check(!!m.profile?.gateway_api_spec)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-white">Per-model readiness checklist</summary>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                {readiness.models.map((m) => (
                  <div key={`ck-${m.manufacturer}|${m.model}`} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                    <p className="font-mono text-[11px] font-bold text-slate-300">{m.manufacturer} {m.model}</p>
                    <ul className="mt-1.5 space-y-1">
                      {m.checklist.map((c) => (
                        <li key={c.item} className="flex items-start gap-1.5 text-[11px] text-slate-400">
                          <span className={`mt-px font-mono ${c.ok ? "text-lime" : "text-amber-300"}`}>{c.ok ? "✓" : "✕"}</span>
                          <span title={c.detail}>{c.item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          </section>
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
