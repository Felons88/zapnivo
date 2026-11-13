"use client";

import { useState } from "react";

type Step = { step: string; ok: boolean; detail: string };
type Result = {
  ok: boolean;
  ran_at: string;
  field: { site_key: string; page_key: string; field_key: string } | null;
  steps: Step[];
  notes: string[];
};

/**
 * CMS acceptance self-test card for /system/sites.
 * POSTs /api/system/sites/selftest (perm system.flags.manage) and renders the
 * per-step result. The test performs a zero-change publish cycle — it cannot
 * alter live content.
 */
export function SelftestCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/system/sites/selftest", { method: "POST" });
      const body = (await res.json().catch(() => null)) as (Result & { error?: string }) | null;
      if (!res.ok || !body) {
        setError(body?.error ?? `Request failed (${res.status})`);
        setResult(null);
        return;
      }
      setResult(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold text-white">CMS acceptance self-test</h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-400">
            Runs a real zero-change publish cycle (same-value draft → publish → DB verify → restore)
            plus a <code className="font-mono">&lt;script&gt;</code> rejection probe. Cannot alter live
            content; rendered HTML may lag the DB by up to 60s (publish cache).
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded-full bg-lime px-4 py-2 font-mono text-xs font-bold text-ink transition-opacity disabled:opacity-50"
        >
          {busy ? "Running…" : "Run self-test"}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4 space-y-3">
          <p className={`text-sm font-bold ${result.ok ? "text-lime" : "text-red-300"}`}>
            {result.ok ? "PASS" : "FAIL"}
            {result.field && (
              <span className="ml-2 font-mono text-xs font-normal text-slate-400">
                {result.field.site_key}/{result.field.page_key}/{result.field.field_key}
              </span>
            )}
          </p>
          <ol className="space-y-1.5">
            {result.steps.map((s, i) => (
              <li key={`${s.step}-${i}`} className="flex gap-3 text-xs">
                <span className={`mt-0.5 font-mono ${s.ok ? "text-lime" : "text-red-300"}`}>
                  {s.ok ? "✓" : "✗"}
                </span>
                <div>
                  <span className="font-mono font-bold text-slate-200">{s.step}</span>
                  <span className="ml-2 text-slate-400">{s.detail}</span>
                </div>
              </li>
            ))}
          </ol>
          {result.notes.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-[11px] text-slate-500">
              {result.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
