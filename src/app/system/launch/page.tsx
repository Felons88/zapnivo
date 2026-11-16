export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { launchReadiness } from "@/lib/system/launch";
import { getAcceptanceChecks, type AcceptanceState, type AcceptanceCheck } from "@/lib/system/acceptance";
import { LaunchBoard } from "./LaunchBoard";

export const metadata: Metadata = { title: "Launch readiness" };

const ACC_STYLE: Record<AcceptanceState, { label: string; cls: string }> = {
  verified: { label: "verified", cls: "bg-lime/15 text-lime ring-lime/30" },
  pending: { label: "pending", cls: "bg-amber-400/10 text-amber-300 ring-amber-400/25" },
  blocked: { label: "blocked", cls: "bg-red-400/10 text-red-300 ring-red-400/25" },
  failed: { label: "failed", cls: "bg-rose-400/10 text-rose-300 ring-rose-400/25" },
};

const ACC_ORDER: AcceptanceState[] = ["failed", "blocked", "pending", "verified"];

function AccBadge({ state }: { state: AcceptanceState }) {
  const s = ACC_STYLE[state];
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${s.cls}`}>
      {s.label}
    </span>
  );
}

export default async function LaunchReadinessPage() {
  const db = serviceClient();
  const [r, acc] = await Promise.all([launchReadiness(db), getAcceptanceChecks(db)]);

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-6">
        <header>
          <p className="eyebrow text-lime">System Control</p>
          <h1 className="display-md mt-1 text-slate-100">Launch readiness</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Track technical activation, verified operations, outstanding requirements, and launch-critical risks.
            Every check reports live evidence only — env vars never count as verified, code alone never counts as operational,
            and physical hardware is never implied. Environment: <span className="font-mono text-slate-300">{r.environment}</span> ·
            last updated {new Date(r.generatedAt).toLocaleString("en-US")}.
          </p>
        </header>

        <LaunchBoard report={r} />

        {/* Acceptance — evidence-based operational verification */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">Operational acceptance testing</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Capabilities proven by recorded evidence only — DB rows showing the flow ran, sent/delivered records,
                executed requests, passed drills. Steps needing a human stay pending until performed.
              </p>
            </div>
            <p className="font-mono text-[10px] text-slate-500">
              {acc.counts.verified} verified · {acc.counts.pending} pending · {acc.counts.blocked} blocked · {acc.counts.failed} failed
            </p>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {acc.categories.map((cat) => (
              <div key={cat.id} className="rounded-xl border border-white/[0.06] bg-black/20 p-4">
                <h3 className="text-[13px] font-semibold text-slate-200">{cat.label}</h3>
                <ul className="mt-2 divide-y divide-white/5">
                  {[...cat.checks]
                    .sort((a, b) => ACC_ORDER.indexOf(a.state) - ACC_ORDER.indexOf(b.state))
                    .map((c: AcceptanceCheck) => (
                      <li key={c.id} className="py-2 first:pt-1 last:pb-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <a href={c.href} className="text-[13px] text-slate-200 hover:text-lime">
                              {c.label}
                            </a>
                            {c.manual && (
                              <span className="ml-2 inline-block rounded-full bg-sky-400/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide text-sky-300 ring-1 ring-sky-400/25">
                                manual
                              </span>
                            )}
                            <p className="mt-0.5 text-[11px] text-slate-500">{c.evidence}</p>
                            {c.blocker && c.state !== "verified" && (
                              <p className="mt-0.5 text-[11px] text-amber-200/80">→ {c.blocker}</p>
                            )}
                          </div>
                          <AccBadge state={c.state} />
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <p className="text-xs text-slate-600">
          Related: <a className="text-sky-400 hover:underline" href="/system/security/readiness">security readiness</a> ·{" "}
          <a className="text-sky-400 hover:underline" href="/system/recovery">recovery</a> ·{" "}
          <a className="text-sky-400 hover:underline" href="/system/app/deployments">deployments</a> ·{" "}
          <a className="text-sky-400 hover:underline" href="/system/jobs">jobs</a>
        </p>
      </div>
    </SystemGate>
  );
}
