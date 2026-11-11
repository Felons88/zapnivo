"use client";

import { useState } from "react";

type Suite = { id: string; name: string; agent_id: string | null; active: boolean; created_at: string };
type Run = { id: number; suite_id: string; agent_id: string; score: number | null; passed: number; total: number; latency_ms: number | null; created_at: string };

export function EvalsClient({ suites, runs }: { suites: Suite[]; runs: Run[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button className="btn btn-primary" disabled={busy !== null} onClick={async () => {
          setBusy("seed"); setMsg("");
          const res = await fetch("/api/admin/evals", { method: "PUT" });
          const d = await res.json().catch(() => ({}));
          setMsg(res.ok ? (d.seeded ? "Default suite created" : "Default suite already exists") : (d.error ?? "Failed"));
          setBusy(null); if (res.ok) setTimeout(() => location.reload(), 800);
        }}>Seed default suite</button>
        {busy === "seed" && <span className="text-sm text-graphite">Working…</span>}
      </div>
      {msg && <p className="text-sm text-graphite">{msg}</p>}

      <section className="card">
        <h2 className="text-lg font-semibold">Suites</h2>
        <table className="mt-3 w-full text-sm">
          <thead><tr className="text-left text-graphite"><th className="py-1">Name</th><th>Agent</th><th>Status</th><th className="text-right">Actions</th></tr></thead>
          <tbody>
            {suites.map((s) => (
              <tr key={s.id} className="border-t border-mist/40">
                <td className="py-2">{s.name}</td>
                <td>{s.agent_id ?? "—"}</td>
                <td>{s.active ? "active" : "inactive"}</td>
                <td className="text-right space-x-2">
                  <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={async () => {
                    setBusy(s.id); setMsg("");
                    const res = await fetch(`/api/admin/evals/${s.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mock: true }) });
                    const d = await res.json().catch(() => ({}));
                    setMsg(res.ok ? `Mock run — score ${Math.round(d.score)} (${d.passed}/${d.total} passed)` : (d.error ?? "Failed"));
                    setBusy(null); if (res.ok) setTimeout(() => location.reload(), 800);
                  }}>Run (mock)</button>
                </td>
              </tr>
            ))}
            {!suites.length && <tr><td colSpan={4} className="py-4 text-graphite">No suites yet — seed the default suite via PUT /api/admin/evals or create one through the API.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">Recent runs</h2>
        <table className="mt-3 w-full text-sm">
          <thead><tr className="text-left text-graphite"><th className="py-1">When</th><th>Suite</th><th>Score</th><th>Passed</th><th>Latency</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-mist/40">
                <td className="py-2">{new Date(r.created_at).toLocaleString()}</td>
                <td className="font-mono text-xs">{r.suite_id.slice(0, 8)}</td>
                <td>{r.score != null ? Math.round(r.score) : "—"}</td>
                <td>{r.passed}/{r.total}</td>
                <td>{r.latency_ms != null ? `${r.latency_ms}ms` : "—"}</td>
              </tr>
            ))}
            {!runs.length && <tr><td colSpan={5} className="py-4 text-graphite">No runs yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
