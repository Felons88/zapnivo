"use client";

import { useState } from "react";

type Result = { status?: string; message?: string; instructions?: string; error?: string; manualSteps?: string[] };

export function RotateForm({ secrets }: { secrets: { envVar: string; provider: string }[] }) {
  const [envVar, setEnvVar] = useState("");
  const [justification, setJustification] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/system/secrets/rotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env_var_name: envVar, justification: justification || undefined }),
      });
      setResult((await res.json()) as Result);
      if (res.ok) { setEnvVar(""); setJustification(""); }
    } catch {
      setResult({ error: "request failed" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-3">
      <label className="text-xs text-slate-400">
        Env var
        <select
          required
          value={envVar}
          onChange={(e) => setEnvVar(e.target.value)}
          className="mt-1 block rounded-lg border border-white/15 bg-ink px-3 py-2 font-mono text-xs text-white"
        >
          <option value="">select…</option>
          {secrets.map((s) => <option key={s.envVar} value={s.envVar}>{s.envVar} ({s.provider})</option>)}
        </select>
      </label>
      <label className="min-w-[220px] flex-1 text-xs text-slate-400">
        Justification
        <input
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          placeholder="why is this rotating?"
          className="mt-1 block w-full rounded-lg border border-white/15 bg-ink px-3 py-2 text-xs text-white"
        />
      </label>
      <button
        type="submit"
        disabled={loading || !envVar}
        className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "requesting…" : "request rotation"}
      </button>
      {result && (
        <div className="w-full rounded-xl border border-white/10 bg-ink/60 p-4 text-xs">
          {result.error ? (
            <p className="text-red-300">Error: {result.error}</p>
          ) : (
            <>
              <p className="font-bold text-lime">{result.status === "pending" ? "Pending approval" : "Rotation tracked"}</p>
              <p className="mt-1 text-slate-300">{result.message}</p>
              {result.instructions && <p className="mt-2 text-slate-400">{result.instructions}</p>}
              {result.manualSteps && (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-400">
                  {result.manualSteps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </form>
  );
}
