"use client";

import { useState } from "react";

type PingState =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "done"; path: string; status: number; latencyMs: number; body: string; truncated: boolean; contentType: string | null }
  | { kind: "error"; path: string; message: string };

/**
 * Safe try-it panel: POSTs {path} to /api/system/dev/ping. The server only
 * proxies paths on the allowlist (GET-only /api/system/* endpoints) and forwards
 * the caller's own session cookie — no arbitrary URLs, no POST, no headers.
 */
export function TryIt({ allowlist }: { allowlist: readonly string[] }) {
  const [path, setPath] = useState<string>(allowlist[0] ?? "");
  const [state, setState] = useState<PingState>({ kind: "idle" });

  async function ping() {
    if (!allowlist.includes(path)) return;
    setState({ kind: "loading", path });
    try {
      const res = await fetch("/api/system/dev/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const json = (await res.json()) as {
        ok?: boolean; status?: number; latencyMs?: number; body?: string;
        truncated?: boolean; contentType?: string | null; error?: string;
      };
      if (json.ok && typeof json.status === "number") {
        setState({
          kind: "done", path, status: json.status, latencyMs: json.latencyMs ?? 0,
          body: json.body ?? "", truncated: !!json.truncated, contentType: json.contentType ?? null,
        });
      } else {
        setState({ kind: "error", path, message: json.error ?? `HTTP ${res.status}` });
      }
    } catch {
      setState({ kind: "error", path, message: "request failed" });
    }
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={path}
          onChange={(e) => setPath(e.target.value)}
          className="rounded-lg border border-white/10 bg-[#0d0d26] px-3 py-2 font-mono text-xs text-slate-200"
        >
          {allowlist.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <button
          onClick={ping}
          disabled={state.kind === "loading" || !allowlist.includes(path)}
          className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8] disabled:opacity-50"
        >
          {state.kind === "loading" ? "pinging…" : "Send GET"}
        </button>
        <span className="font-mono text-[10px] text-slate-500">GET only · your session · 30/min · body capped at 8KB</span>
      </div>

      {state.kind === "done" && (
        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
          <p className="font-mono text-[11px]">
            <span className={state.status < 400 ? "text-lime" : "text-red-300"}>HTTP {state.status}</span>
            <span className="ml-3 text-slate-400">{state.latencyMs}ms</span>
            {state.contentType && <span className="ml-3 text-slate-500">{state.contentType}</span>}
            {state.truncated && <span className="ml-3 text-amber-300">truncated at 8KB</span>}
          </p>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-slate-300">{state.body || "(empty body)"}</pre>
        </div>
      )}
      {state.kind === "error" && (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 font-mono text-xs text-red-300">
          {state.path} → {state.message}
        </p>
      )}
    </div>
  );
}
