export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { launchReadiness, type LaunchStatus, type LaunchSubsystem } from "@/lib/system/launch";

export const metadata: Metadata = { title: "Launch readiness" };

const STATUS_STYLE: Record<LaunchStatus, { label: string; cls: string }> = {
  verified: { label: "verified", cls: "bg-lime/15 text-lime ring-lime/30" },
  operational: { label: "operational", cls: "bg-lime/15 text-lime ring-lime/30" },
  partially_operational: { label: "partial", cls: "bg-teal-400/10 text-teal-300 ring-teal-400/25" },
  configured: { label: "configured", cls: "bg-sky-400/10 text-sky-300 ring-sky-400/25" },
  implemented: { label: "implemented", cls: "bg-slate-400/10 text-slate-300 ring-slate-400/25" },
  test_verified: { label: "test-verified", cls: "bg-teal-400/10 text-teal-300 ring-teal-400/25" },
  blocked: { label: "blocked", cls: "bg-red-400/10 text-red-300 ring-red-400/25" },
  requires_manual_action: { label: "manual action", cls: "bg-amber-400/10 text-amber-300 ring-amber-400/25" },
  unverified: { label: "unverified", cls: "bg-amber-400/10 text-amber-300 ring-amber-400/25" },
};

const ORDER: LaunchStatus[] = [
  "blocked", "requires_manual_action", "unverified", "partially_operational",
  "configured", "implemented", "test_verified", "operational", "verified",
];

function Badge({ status }: { status: LaunchStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${s.cls}`}>
      {s.label}
    </span>
  );
}

export default async function LaunchReadinessPage() {
  const db = serviceClient();
  const r = await launchReadiness(db);
  const sorted = [...r.subsystems].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status),
  );

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-6">
        <header>
          <p className="eyebrow text-lime">System Control</p>
          <h1 className="display-md mt-1 text-slate-100">Launch readiness</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Platform-wide commercial-launch posture. Statuses reflect live evidence only —
            unit tests never count as verified, env vars never count as configured-and-working,
            and physical hardware is never implied. Generated{" "}
            {new Date(r.generatedAt).toLocaleString("en-US")}.
          </p>
        </header>

        {/* Counts strip */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {(["blocked", "requires_manual_action", "unverified", "partially_operational", "configured", "operational", "verified"] as LaunchStatus[]).map((s) => (
            <div key={s} className="rounded-xl border border-white/5 bg-black/20 px-3 py-2.5 text-center">
              <p className="font-mono text-2xl font-bold text-slate-100">{r.counts[s]}</p>
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-500">{STATUS_STYLE[s].label}</p>
            </div>
          ))}
        </section>

        {/* Blockers — the "what's left" answer */}
        {r.blockers.length > 0 && (
          <section className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-5">
            <h2 className="eyebrow text-amber-300">Open blockers ({r.blockers.length})</h2>
            <ul className="mt-3 space-y-1.5 text-sm text-slate-300">
              {r.blockers.map((b, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                  <span><span className="text-slate-500">{b.subsystem}:</span> {b.item}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Subsystem cards */}
        <div className="grid gap-4 lg:grid-cols-2">
          {sorted.map((s: LaunchSubsystem) => (
            <section key={s.id} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold text-slate-100">{s.label}</h2>
                <Badge status={s.status} />
              </div>
              <p className="mt-2 text-sm text-slate-400">{s.evidence}</p>
              {s.blockers.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-white/5 pt-3">
                  {s.blockers.map((b, i) => (
                    <li key={i} className="flex gap-2 text-xs text-slate-500">
                      <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-slate-600" />
                      {b}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>

        <p className="text-xs text-slate-600">
          Related: <a className="text-sky-400 hover:underline" href="/system/security/readiness">security readiness</a> ·{" "}
          <a className="text-sky-400 hover:underline" href="/system/recovery">recovery</a> ·{" "}
          <a className="text-sky-400 hover:underline" href="/system/app/deployments">deployments</a>
        </p>
      </div>
    </SystemGate>
  );
}
