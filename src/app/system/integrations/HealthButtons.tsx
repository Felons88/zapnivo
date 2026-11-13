"use client";

import { useState } from "react";

type Verification = {
  verified: boolean;
  writeCapability?: "proven" | "unverified" | "none";
  permissions?: {
    grantedScopes?: string[];
    scopeLabels?: string[];
    identity?: { kind: string; id: string | null; label: string | null; count?: number } | null;
    note?: string | null;
  } | null;
};

type Health = { status: string; detail: string; latencyMs: number | null };
type State = "idle" | "loading" | { health: Health; verification: Verification | null };

/** Per-provider "Run check" button → GET /api/system/integrations/[id]/health.
 *  Deploy providers (github/vercel) also return a `verification` object with
 *  granted scopes, token identity and honest write-capability state. */
export function HealthButtons({ id, configured }: { id: string; configured: boolean }) {
  const [state, setState] = useState<State>("idle");

  async function run() {
    setState("loading");
    try {
      const res = await fetch(`/api/system/integrations/${encodeURIComponent(id)}/health`, { cache: "no-store" });
      const json = (await res.json()) as { health?: Health; verification?: Verification | null; error?: string };
      setState({
        health: json.health ?? { status: "unknown", detail: json.error ?? `HTTP ${res.status}`, latencyMs: null },
        verification: json.verification ?? null,
      });
    } catch {
      setState({ health: { status: "unknown", detail: "request failed", latencyMs: null }, verification: null });
    }
  }

  const result = state !== "idle" && state !== "loading" ? state : null;
  const ver = result?.verification ?? null;
  const scopes = ver?.permissions?.grantedScopes ?? [];
  const identity = ver?.permissions?.identity ?? null;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={state === "loading"}
        className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
      >
        {state === "loading" ? "checking…" : "run check"}
      </button>
      {result && (
        <span className="max-w-[260px] text-right font-mono text-[10px] leading-tight text-slate-400" title={result.health.detail}>
          {result.health.status}{result.health.latencyMs != null ? ` · ${result.health.latencyMs}ms` : ""} — {result.health.detail.slice(0, 80)}
        </span>
      )}
      {ver && (
        <span className="max-w-[280px] text-right font-mono text-[10px] leading-tight text-slate-500">
          {ver.verified ? "read ✓" : "read ✗"}
          {ver.writeCapability ? ` · write ${ver.writeCapability}` : ""}
          {identity?.label ? ` · ${identity.kind}:${identity.label}` : ""}
          {scopes.length > 0 ? ` · scopes: ${scopes.slice(0, 4).join(",")}${scopes.length > 4 ? "…" : ""}` : ""}
        </span>
      )}
      {!configured && state === "idle" && <span className="font-mono text-[10px] text-slate-500">skipped: unconfigured</span>}
    </div>
  );
}
