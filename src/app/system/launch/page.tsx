export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { launchReadiness, type LaunchStatus, type LaunchSubsystem } from "@/lib/system/launch";
import { getOpsStatus, type OpsState, type OpsCard } from "@/lib/system/ops-status";

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

const OPS_STYLE: Record<OpsState, { label: string; cls: string }> = {
  operational: { label: "operational", cls: "bg-lime/15 text-lime ring-lime/30" },
  degraded: { label: "degraded", cls: "bg-red-400/10 text-red-300 ring-red-400/25" },
  not_configured: { label: "not configured", cls: "bg-slate-400/10 text-slate-300 ring-slate-400/25" },
  blocked: { label: "blocked", cls: "bg-red-400/10 text-red-300 ring-red-400/25" },
  requires_action: { label: "action needed", cls: "bg-amber-400/10 text-amber-300 ring-amber-400/25" },
};

const OPS_ORDER: OpsState[] = ["degraded", "blocked", "requires_action", "not_configured", "operational"];

function OpsBadge({ state }: { state: OpsState }) {
  const s = OPS_STYLE[state];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${s.cls}`}>
      {s.label}
    </span>
  );
}

export default async function LaunchReadinessPage() {
  const db = serviceClient();
  const [r, ops] = await Promise.all([launchReadiness(db), getOpsStatus(db)]);
  const sorted = [...r.subsystems].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status),
  );
  const opsSorted = [...ops.cards].sort(
    (a, b) => OPS_ORDER.indexOf(a.state) - OPS_ORDER.indexOf(b.state),
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

        {/* Operations — live integration/subsystem readiness */}
        <section>
          <h2 className="eyebrow text-slate-400">Operations</h2>
          <p className="mt-1 text-xs text-slate-500">
            Per-subsystem integration state. “Operational” requires a passing live or recorded check —
            env vars alone never qualify. Checked {new Date(ops.generatedAt).toLocaleTimeString("en-US")}.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {opsSorted.map((c: OpsCard) => (
              <a
                key={c.id}
                href={c.href}
                className="block rounded-xl border border-white/[0.08] bg-white/[0.04] p-4 transition-colors hover:border-lime/30"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-200">{c.label}</h3>
                  <OpsBadge state={c.state} />
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  {c.verified === true ? "verified" : c.verified === false ? "check failed" : "unverified"}
                  {" · "}checked {new Date(c.lastChecked).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </p>
                {c.nextAction && <p className="mt-1.5 text-xs text-amber-200/80">→ {c.nextAction}</p>}
              </a>
            ))}
          </div>
        </section>

        <p className="text-xs text-slate-600">
          Related: <a className="text-sky-400 hover:underline" href="/system/security/readiness">security readiness</a> ·{" "}
          <a className="text-sky-400 hover:underline" href="/system/recovery">recovery</a> ·{" "}
          <a className="text-sky-400 hover:underline" href="/system/app/deployments">deployments</a>
        </p>
      </div>
    </SystemGate>
  );
}
