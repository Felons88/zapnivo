"use client";

import { useCallback, useMemo, useState } from "react";
import type {
  LaunchReadiness, LaunchCheck, LaunchBlocker, LaunchSubsystemId,
  CheckState, CheckSeverity, CheckOwner, LaunchLineId, LaunchGateId,
} from "@/lib/system/launch-shared";
import { LAUNCH_SUBSYSTEMS, LAUNCH_GATES, LAUNCH_LINES } from "@/lib/system/launch-shared";

/* ── Display vocab ────────────────────────────────────────────────────────── */

const STATE_STYLE: Record<CheckState, { label: string; cls: string }> = {
  verified: { label: "verified", cls: "bg-lime/15 text-lime ring-lime/30" },
  operational: { label: "operational", cls: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/25" },
  configured: { label: "configured", cls: "bg-sky-400/10 text-sky-300 ring-sky-400/25" },
  implemented: { label: "implemented", cls: "bg-slate-400/10 text-slate-300 ring-slate-400/25" },
  test_verified: { label: "test-verified", cls: "bg-teal-400/10 text-teal-300 ring-teal-400/25" },
  pending: { label: "pending", cls: "bg-amber-400/10 text-amber-300 ring-amber-400/25" },
  blocked: { label: "blocked", cls: "bg-red-400/10 text-red-300 ring-red-400/25" },
  manual: { label: "manual", cls: "bg-orange-400/10 text-orange-300 ring-orange-400/25" },
};

const SEV_STYLE: Record<CheckSeverity, { label: string; cls: string; rank: number }> = {
  critical: { label: "P0", cls: "bg-red-400/15 text-red-300 ring-red-400/40", rank: 0 },
  high: { label: "P1", cls: "bg-orange-400/15 text-orange-300 ring-orange-400/40", rank: 1 },
  medium: { label: "P2", cls: "bg-amber-400/15 text-amber-300 ring-amber-400/40", rank: 2 },
  low: { label: "P3", cls: "bg-slate-400/15 text-slate-300 ring-slate-400/40", rank: 3 },
};

const OWNER_LABEL: Record<CheckOwner, string> = {
  owner: "Owner", developer: "Developer", provider: "Provider", hardware: "Hardware",
};

const GATE_WORST: Record<string, { label: string; cls: string }> = {
  satisfied: { label: "satisfied", cls: "text-lime" },
  verified: { label: "verified", cls: "text-lime" },
  operational: { label: "operational", cls: "text-emerald-300" },
  configured: { label: "configured", cls: "text-sky-300" },
  implemented: { label: "implemented", cls: "text-slate-300" },
  test_verified: { label: "test-verified", cls: "text-teal-300" },
  pending: { label: "pending", cls: "text-amber-300" },
  manual: { label: "manual", cls: "text-orange-300" },
  blocked: { label: "blocked", cls: "text-red-300" },
};

const STATE_RANK: Record<CheckState, number> = {
  verified: 0, operational: 1, configured: 2, implemented: 3, test_verified: 4,
  pending: 5, manual: 6, blocked: 7,
};
const UNSATISFIED = new Set<CheckState>(["pending", "blocked", "manual"]);

function Badge({ state }: { state: CheckState }) {
  const s = STATE_STYLE[state];
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${s.cls}`}>{s.label}</span>;
}

function SevBadge({ sev }: { sev: CheckSeverity }) {
  const s = SEV_STYLE[sev];
  return <span className={`inline-block rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${s.cls}`}>{s.label}</span>;
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ── Subsystem card ───────────────────────────────────────────────────────── */

function SubsystemCard({ id, checks, defaultOpen }: { id: LaunchSubsystemId; checks: LaunchCheck[]; defaultOpen: boolean }) {
  const label = LAUNCH_SUBSYSTEMS.find((s) => s.id === id)?.label ?? id;
  const unsat = checks.filter((c) => UNSATISFIED.has(c.state));
  const worst = unsat.length ? unsat.reduce((w, c) => (STATE_RANK[c.state] > STATE_RANK[w.state] ? c : w), unsat[0]) : null;
  const verified = checks.filter((c) => c.state === "verified" || c.state === "operational").length;
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.03]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={open}>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-200">{label}</h3>
          <p className="mt-0.5 font-mono text-[10px] text-slate-500">
            {verified}/{checks.length} working{worst ? ` · worst: ${STATE_STYLE[worst.state].label}` : " · all satisfied"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {worst && <SevBadge sev={worst.severity} />}
          {worst ? <Badge state={worst.state} /> : <Badge state="verified" />}
          <span className={`text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        </div>
      </button>
      {open && (
        <ul className="divide-y divide-white/5 border-t border-white/5">
          {[...checks].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.id.localeCompare(b.id)).map((c) => (
            <li key={c.id} className="px-4 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-slate-200">{c.label}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{c.evidence}</p>
                  {c.action && UNSATISFIED.has(c.state) && (
                    <p className="mt-1 text-[11px] text-amber-200/80">
                      → {c.action}
                      {c.actionHref && <> <a className="text-sky-400 hover:underline" href={c.actionHref}>Open →</a></>}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge state={c.state} />
                  {UNSATISFIED.has(c.state) && <SevBadge sev={c.severity} />}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── Board ────────────────────────────────────────────────────────────────── */

export function LaunchBoard({ report }: { report: LaunchReadiness }) {
  const [line, setLine] = useState<LaunchLineId>("full_platform");
  const [sevFilter, setSevFilter] = useState<CheckSeverity | "all">("all");
  const [ownerFilter, setOwnerFilter] = useState<CheckOwner | "all">("all");
  const [gateFilter, setGateFilter] = useState<LaunchGateId | "all">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"severity" | "subsystem" | "state">("severity");

  const inLine = useCallback((c: LaunchCheck) => line === "full_platform" || c.lines.includes(line) || c.lines.includes("full_platform"), [line]);

  const visibleChecks = useMemo(
    () => report.checks.filter(inLine),
    [report.checks, inLine],
  );

  const visibleBlockers = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = report.blockers.filter((b) => {
      if (!visibleChecks.some((c) => c.id === b.checkId)) return false;
      if (sevFilter !== "all" && b.severity !== sevFilter) return false;
      if (ownerFilter !== "all" && b.owner !== ownerFilter) return false;
      if (gateFilter !== "all" && b.gate !== gateFilter) return false;
      if (q && !(`${b.problem} ${b.action} ${b.subsystem}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const sevRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    const subLabel = (id: string) => LAUNCH_SUBSYSTEMS.find((s) => s.id === id)?.label ?? id;
    list = [...list].sort((a, b) => {
      if (sort === "subsystem") return subLabel(a.subsystem).localeCompare(subLabel(b.subsystem)) || sevRank[a.severity] - sevRank[b.severity];
      if (sort === "state") return STATE_RANK[a.evidenceStatus] - STATE_RANK[b.evidenceStatus] || sevRank[a.severity] - sevRank[b.severity];
      return sevRank[a.severity] - sevRank[b.severity] || subLabel(a.subsystem).localeCompare(subLabel(b.subsystem));
    });
    return list;
  }, [report.blockers, visibleChecks, sevFilter, ownerFilter, gateFilter, query, sort]);

  const lineChecks = visibleChecks;
  const lineSummary = useMemo(() => {
    const s = { verified: 0, operational: 0, configured: 0, implemented: 0, test_verified: 0, pending: 0, blocked: 0, manual: 0 };
    for (const c of lineChecks) s[c.state]++;
    return s;
  }, [lineChecks]);

  const openSubsystems = report.subsystems.filter((s) => s.checks.some((c) => inLine(c) && UNSATISFIED.has(c.state)));

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {([
          ["Production verified", report.summary.productionVerified, "text-lime"],
          ["Operational", report.summary.operational, "text-emerald-300"],
          ["Needs configuration", report.summary.needsConfiguration, "text-sky-300"],
          ["Critical blockers", report.summary.criticalBlockers, "text-red-300"],
          ["Manual verification pending", report.summary.manualPending, "text-orange-300"],
        ] as const).map(([label, value, cls]) => (
          <div key={label} className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3">
            <p className={`font-mono text-2xl font-bold ${cls}`}>{value}</p>
            <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
          </div>
        ))}
      </section>

      {/* Business line + gates */}
      <section>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Readiness view</span>
          {LAUNCH_LINES.map((l) => (
            <button key={l.id} type="button" onClick={() => setLine(l.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors ${line === l.id ? "bg-lime text-ink ring-lime" : "bg-white/[0.04] text-slate-300 ring-white/10 hover:ring-lime/40"}`}>
              {l.label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {report.gates.map((g) => {
            const pct = g.total ? Math.round((g.satisfied / g.total) * 100) : 0;
            const w = GATE_WORST[g.worst] ?? GATE_WORST.satisfied;
            return (
              <div key={g.id} className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[13px] font-semibold text-slate-200">{g.label}</h3>
                  <span className={`font-mono text-[10px] font-bold uppercase ${w.cls}`}>{g.worst === "satisfied" ? "clear" : w.label}</span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-slate-500">{g.description}</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className={`h-full rounded-full ${g.criticalOpen ? "bg-red-400" : g.satisfied === g.total ? "bg-lime" : "bg-sky-400"}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1.5 font-mono text-[10px] text-slate-500">
                  {g.satisfied}/{g.total} checks satisfied{g.criticalOpen ? ` · ${g.criticalOpen} critical open` : ""}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Blocker table */}
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-200">Blockers &amp; open items</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">{visibleBlockers.length} item(s) — one row per check, deduplicated by stable ID.</p>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search blockers…"
            className="w-52 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-lime/50 focus:outline-none"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(["all", "critical", "high", "medium", "low"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSevFilter(s)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${sevFilter === s ? "bg-white/10 text-white ring-white/30" : "text-slate-400 ring-white/10 hover:text-slate-200"}`}>
              {s === "all" ? "All severities" : SEV_STYLE[s].label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-white/10" />
          {(["all", "owner", "developer", "provider", "hardware"] as const).map((o) => (
            <button key={o} type="button" onClick={() => setOwnerFilter(o)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${ownerFilter === o ? "bg-lime/20 text-lime ring-lime/40" : "text-slate-400 ring-white/10 hover:text-slate-200"}`}>
              {o === "all" ? "All owners" : OWNER_LABEL[o]}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-white/10" />
          <select value={gateFilter} onChange={(e) => setGateFilter(e.target.value as LaunchGateId | "all")}
            className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-300 focus:outline-none">
            <option value="all">All gates</option>
            {LAUNCH_GATES.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}
            className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-300 focus:outline-none">
            <option value="severity">Sort: severity</option>
            <option value="subsystem">Sort: subsystem</option>
            <option value="state">Sort: state</option>
          </select>
        </div>
        {visibleBlockers.length === 0 ? (
          <p className="mt-4 rounded-lg border border-lime/20 bg-lime/[0.04] px-4 py-3 text-sm text-lime">No open blockers for this view — everything evaluated is satisfied.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-white/10 font-mono text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3">Priority</th>
                  <th className="py-2 pr-3">Subsystem</th>
                  <th className="py-2 pr-3">Problem</th>
                  <th className="py-2 pr-3">Required action</th>
                  <th className="py-2 pr-3">Owner</th>
                  <th className="py-2 pr-3">Evidence</th>
                  <th className="py-2">Checked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {visibleBlockers.map((b) => (
                  <tr key={b.id} className="align-top">
                    <td className="py-2.5 pr-3"><SevBadge sev={b.severity} /></td>
                    <td className="py-2.5 pr-3 text-slate-400">{LAUNCH_SUBSYSTEMS.find((s) => s.id === b.subsystem)?.label ?? b.subsystem}</td>
                    <td className="max-w-[280px] py-2.5 pr-3 text-slate-300">{b.problem}</td>
                    <td className="max-w-[280px] py-2.5 pr-3 text-slate-400">
                      {b.action}
                      {b.href && <> <a className="whitespace-nowrap text-sky-400 hover:underline" href={b.href}>Open →</a></>}
                    </td>
                    <td className="py-2.5 pr-3 text-slate-400">{OWNER_LABEL[b.owner]}</td>
                    <td className="py-2.5 pr-3"><Badge state={b.evidenceStatus} /></td>
                    <td className="py-2.5 text-slate-500">{timeAgo(b.lastChecked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Owner action center */}
      {report.ownerActions.length > 0 && (
        <section className="rounded-2xl border border-lime/20 bg-lime/[0.03] p-4">
          <h2 className="text-sm font-semibold text-lime">Owner action center</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">Tasks only you can complete — env vars, dashboards, legal sign-offs, provider accounts. Each clears automatically once evidence verifies.</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {report.ownerActions.map((b) => (
              <li key={b.id} className="rounded-lg border border-white/[0.07] bg-black/20 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[13px] font-medium text-slate-200">{b.problem.split(" — ")[0]}</p>
                  <SevBadge sev={b.severity} />
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{b.action}</p>
                {b.href && <a href={b.href} className="mt-1.5 inline-block text-[11px] font-semibold text-lime hover:underline">Open setup →</a>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Subsystem cards */}
      <section>
        <h2 className="text-sm font-semibold text-slate-200">Subsystem readiness</h2>
        <p className="mt-0.5 text-[11px] text-slate-500">{lineChecks.length} checks in this view · expand a card for per-check evidence.</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {report.subsystems.map((s) => (
            <SubsystemCard
              key={s.id}
              id={s.id}
              checks={s.checks.filter(inLine)}
              defaultOpen={openSubsystems.some((o) => o.id === s.id)}
            />
          ))}
        </div>
      </section>

      {/* Readiness history */}
      {report.history.length > 0 && (
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
          <h2 className="text-sm font-semibold text-slate-200">Readiness history</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">State transitions recorded on each evaluation — regressions stay visible.</p>
          <ul className="mt-3 space-y-1.5">
            {report.history.slice(0, 20).map((e) => {
              const check = report.checks.find((c) => c.id === e.check_id);
              return (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                  <span className="font-mono text-slate-500">{new Date(e.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  <span className="text-slate-300">{check?.label ?? e.check_id}</span>
                  <span className="text-slate-500">
                    {e.previous_state ?? "new"} → <span className={e.new_state === "blocked" ? "text-red-300" : "text-lime"}>{e.new_state}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

