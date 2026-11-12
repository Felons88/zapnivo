"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Report = {
  ok: boolean;
  dryRun: boolean;
  results: { table: string; matched: number; deleted: number; skipped?: boolean; error?: string }[];
  error?: string;
};

/** Dry-run / execute controls for the retention page. */
export function RetentionControls({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"dry_run" | "execute" | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!canManage) return null;

  const run = async (mode: "dry_run" | "execute") => {
    setBusy(mode); setReport(null); setMessage(null);
    try {
      const res = await fetch("/api/system/retention/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 202) {
        setMessage(`Pending approval — change request ${(j as { changeRequestId?: string }).changeRequestId ?? ""} created. A different principal must approve it under Changes before execute runs.`);
      } else if (!res.ok && !(j as { report?: Report }).report) {
        setMessage((j as { error?: string }).error ?? `HTTP ${res.status}`);
      } else {
        setReport((j as { report: Report }).report ?? null);
        if (!(j as { report?: Report }).report) setMessage((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const matched = report?.results.reduce((a, r) => a + r.matched, 0) ?? 0;
  const deleted = report?.results.reduce((a, r) => a + r.deleted, 0) ?? 0;

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="eyebrow text-slate-400">Manual sweep</h2>
          <p className="mt-1 text-xs text-slate-500">
            Dry-run counts eligible rows and deletes nothing. Execute deletes bounded batches and{" "}
            <strong className="text-amber-300">requires an approved change request for production</strong> (high risk —
            first attempt creates one under Changes for a different principal to approve).
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button" disabled={busy !== null} onClick={() => run("dry_run")}
            className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
          >
            {busy === "dry_run" ? "Running…" : "Dry run"}
          </button>
          <button
            type="button" disabled={busy !== null} onClick={() => run("execute")}
            className="rounded-full bg-amber-400/15 px-4 py-2 text-xs font-bold text-amber-300 ring-1 ring-amber-400/30 hover:bg-amber-400/25 disabled:opacity-50"
          >
            {busy === "execute" ? "Running…" : "Execute (all telemetry)"}
          </button>
        </div>
      </div>

      {message && <p className="mt-3 font-mono text-xs text-amber-300">{message}</p>}

      {report && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>{["Table", "Eligible", "Deleted", "Status"].map((h) => <th key={h} className="py-2 pr-4 font-extrabold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {report.results.map((r) => (
                <tr key={r.table} className="border-b border-white/5 last:border-0">
                  <td className="py-2 pr-4 font-mono font-bold text-lime">{r.table}</td>
                  <td className="py-2 pr-4 font-mono text-slate-200">{r.matched}</td>
                  <td className="py-2 pr-4 font-mono text-slate-200">{r.deleted}</td>
                  <td className="py-2 pr-4 font-mono text-[10px]">
                    {r.error ? <span className="text-red-300">{r.skipped ? `skipped — ${r.error}` : r.error}</span>
                      : r.skipped ? <span className="text-slate-500">skipped</span>
                      : <span className="text-lime">ok</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 font-mono text-[11px] text-slate-500">
            {report.dryRun ? "dry-run" : "execute"} · matched {matched} · deleted {deleted}
            {report.ok ? "" : " · completed with errors (see table)"}
          </p>
        </div>
      )}
    </section>
  );
}
