export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { CAPABILITY_CHECKS, listHardwareProfiles, type HardwareCertStatus } from "@/lib/system/hardware";

export const metadata: Metadata = { title: "Hardware readiness" };

const certTone = (s: string) =>
  s === "certified" ? "bg-lime/15 text-lime ring-lime/30"
  : s === "in_review" ? "bg-sky-400/15 text-sky-300 ring-sky-400/30"
  : s === "deprecated" ? "bg-white/5 text-slate-500 ring-white/10"
  : "bg-amber-400/15 text-amber-300 ring-amber-400/30";

const boolCell = (v: boolean) =>
  v ? <span className="text-lime">✓</span> : <span className="text-slate-600">—</span>;

/**
 * Hardware readiness — vendor capability/certification registry.
 * system_hardware_profiles is ops-managed (migration/seed only — there is NO
 * write API). Empty until a real unit + protocol docs have been inspected;
 * nothing here claims hardware compatibility (adapter contract:
 * src/lib/kiosk/adapter-contract.ts, KIOSK_ADAPTER=none).
 */
export default async function HardwarePage() {
  const db = serviceClient();
  const { configured, profiles } = await listHardwareProfiles(db);

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Kiosk Infrastructure</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Hardware readiness</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Vendor hardware profiles from <code className="font-mono text-xs">system_hardware_profiles</code>.
            Profiles are added via ops migrations only after a physical unit and its protocol documentation have
            been inspected — there is deliberately no write API. Adapter contract reference:{" "}
            <code className="font-mono text-xs">src/lib/kiosk/adapter-contract.ts</code>.{" "}
            <Link href="/system/kiosks" className="text-lime underline">← Fleet registry</Link>
          </p>
        </div>

        {!configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — hardware profiles unavailable.
          </p>
        )}

        {configured && profiles.length === 0 && (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10">
            <p className="text-sm font-bold text-slate-200">No hardware profiles certified.</p>
            <p className="mt-2 max-w-xl text-xs leading-relaxed text-slate-400">
              The registry is intentionally empty — no vendor hardware has been inspected and certified yet.
              Add profiles via an ops migration once a real unit, its gateway protocol docs, and bench test
              results exist. Until then every device reports <span className="font-mono">hardware_confirmed: unverified</span>.
            </p>
          </div>
        )}

        {profiles.length > 0 && (
          <div className="overflow-x-auto rounded-2xl border border-white/[0.08]">
            <table className="w-full min-w-[1100px] text-left text-xs">
              <thead className="border-b border-white/10 bg-white/[0.06] text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-extrabold">Manufacturer / Model</th>
                  <th className="px-4 py-3 font-extrabold">Certification</th>
                  {CAPABILITY_CHECKS.map((c) => <th key={c.key} className="px-3 py-3 text-center font-extrabold" title={c.label}>{c.label}</th>)}
                  <th className="px-4 py-3 font-extrabold">Docs</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <p className="font-bold text-slate-200">{p.manufacturer} {p.model}</p>
                      <p className="font-mono text-[10px] text-slate-500">{p.id.slice(0, 8)}… · added {new Date(p.created_at).toISOString().slice(0, 10)}</p>
                      {Object.keys(p.auth_capabilities ?? {}).length > 0 && (
                        <code className="mt-1 block max-w-[220px] break-all text-[10px] text-slate-500">{JSON.stringify(p.auth_capabilities).slice(0, 120)}</code>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${certTone(p.certification_status)}`}>{p.certification_status}</span>
                    </td>
                    {CAPABILITY_CHECKS.map((c) => (
                      <td key={c.key} className="px-3 py-3 text-center">{boolCell(Boolean(p[c.key as keyof typeof p]))}</td>
                    ))}
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        {p.protocol_doc_url && <a href={p.protocol_doc_url} target="_blank" rel="noreferrer" className="block text-lime underline">protocol doc</a>}
                        {p.gateway_api_spec && <span className="block font-mono text-[10px] text-slate-400">{p.gateway_api_spec.slice(0, 60)}</span>}
                        {!p.protocol_doc_url && !p.gateway_api_spec && <span className="text-slate-600">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-slate-500">
          Firmware inventory lives at <Link href="/system/kiosks/firmware" className="text-lime underline">/system/kiosks/firmware</Link>.
          Certification statuses: <span className="font-mono">uncertified · in_review · certified · deprecated</span>.
        </p>
      </div>
    </SystemGate>
  );
}
