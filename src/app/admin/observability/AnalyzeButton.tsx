"use client";
import { useState } from "react";

type Analysis = {
  summary: string;
  likelyCauses: string[];
  correlatedSignals: string[];
  suggestedTests: string[];
  draftIssue: { title: string; body: string };
  confidence: "low" | "medium" | "high";
};

type Result = { ok: true; analysis: Analysis } | { ok: false; error: string };

const CONFIDENCE_TONE: Record<Analysis["confidence"], string> = {
  high: "bg-lime/40 text-forest",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-mist text-graphite",
};

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-graphite">{title}</h4>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((x, i) => <li key={i}>{x}</li>)}
      </ul>
    </div>
  );
}

/** "Analyze with AI" for one error_issue — POSTs to the staff-only analyze route and shows a dismissible panel. */
export function AnalyzeButton({ issueId }: { issueId: string }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/observability/issues/${issueId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await res.json().catch(() => null)) as { analysis?: Analysis; error?: string } | null;
      if (res.ok && data?.analysis) setResult({ ok: true, analysis: data.analysis });
      else setResult({ ok: false, error: data?.error ?? `Request failed (${res.status})` });
    } catch {
      setResult({ ok: false, error: "Network error — try again." });
    }
    setBusy(false);
    setOpen(true);
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="rounded-full border border-mist px-2 py-0.5 text-[11px] font-bold hover:border-ink disabled:opacity-40"
      >
        {busy ? "Analyzing…" : "Analyze with AI"}
      </button>
      {open && result && (
        <div className="w-[28rem] max-w-[80vw] rounded-xl border border-mist bg-paper p-4 text-left shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-bold">AI analysis</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full px-2 py-0.5 text-[11px] font-bold text-graphite hover:bg-mist"
              aria-label="Dismiss analysis"
            >
              Dismiss
            </button>
          </div>
          {!result.ok ? (
            <p className="mt-2 text-sm text-red-700">{result.error}</p>
          ) : (
            <div className="mt-2 space-y-3">
              <p className="flex items-center gap-2 text-sm">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase ${CONFIDENCE_TONE[result.analysis.confidence]}`}>
                  {result.analysis.confidence} confidence
                </span>
              </p>
              {result.analysis.summary && <p className="text-sm">{result.analysis.summary}</p>}
              <List title="Likely causes" items={result.analysis.likelyCauses} />
              <List title="Correlated signals" items={result.analysis.correlatedSignals} />
              <List title="Suggested regression tests" items={result.analysis.suggestedTests} />
              {(result.analysis.draftIssue.title || result.analysis.draftIssue.body) && (
                <div>
                  <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-graphite">Draft issue</h4>
                  <div className="mt-1 rounded-lg border border-mist bg-white p-3">
                    {result.analysis.draftIssue.title && <p className="text-sm font-bold">{result.analysis.draftIssue.title}</p>}
                    {result.analysis.draftIssue.body && (
                      <pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-graphite">{result.analysis.draftIssue.body}</pre>
                    )}
                  </div>
                </div>
              )}
              <p className="text-[10px] text-graphite">Read-only analysis — review before acting. Runs are recorded under the ops.debugger agent.</p>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
