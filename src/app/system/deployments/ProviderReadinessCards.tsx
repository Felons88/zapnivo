"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export type ProviderCardData = {
  provider: "vercel" | "github";
  name: string;
  configured: boolean;
  missing: string[];
  /** Env var presence for credential chips. */
  envPresence: { name: string; set: boolean }[];
  /** Last audited health check (integration.health_checked). */
  lastHealthCheck: { status: string; checkedAt: string; latencyMs: number | null; detail: string | null } | null;
  requiredAction: string;
};

type VerifyResult = {
  configured: boolean;
  verified: boolean;
  latencyMs: number | null;
  capabilities: string[];
  detail: string | null;
  requiredAction: string | null;
  lastSuccessAt: string | null;
};

const STATUS_TONE: Record<string, string> = {
  operational: "bg-lime/15 text-lime ring-lime/30",
  degraded: "bg-red-500/15 text-red-300 ring-red-400/30",
  unconfigured: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  unknown: "bg-white/10 text-slate-400 ring-white/15",
  requires_credentials: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  not_verified: "bg-white/10 text-slate-400 ring-white/15",
};

/**
 * Per-provider connection readiness cards for /system/deployments.
 * Shows credential env-var chips, the last audited health check, a verified
 * badge, proven read capabilities, and a "Run verification" button that hits
 * GET /api/system/deployments/verify (cached ~5min server-side, audited).
 */
export function ProviderReadinessCards({ providers }: { providers: ProviderCardData[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {providers.map((p) => <ProviderCard key={p.provider} data={p} />)}
    </div>
  );
}

function ProviderCard({ data }: { data: ProviderCardData }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runVerify = async (force: boolean) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/system/deployments/verify?provider=${data.provider}${force ? "&force=1" : ""}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      } else {
        setResult((j as { verification: VerifyResult }).verification);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const hc = data.lastHealthCheck;
  const verified = result ? result.verified : hc?.status === "operational";
  const capabilities = result?.capabilities ?? [];

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="eyebrow text-slate-400">{data.name} provider</h2>
        <div className="flex items-center gap-2">
          {verified ? (
            <span className="rounded-full bg-lime/15 px-2 py-0.5 font-mono text-[10px] font-bold text-lime ring-1 ring-lime/30">verified</span>
          ) : data.configured ? (
            <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-400 ring-1 ring-white/15">unverified</span>
          ) : (
            <span className="rounded-full bg-amber-400/15 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-300 ring-1 ring-amber-400/30">requires_credentials</span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => runVerify(Boolean(result))}
            className="rounded-full bg-white/10 px-3 py-1 font-mono text-[10px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
          >
            {busy ? "checking…" : result ? "re-check" : "verify connection"}
          </button>
        </div>
      </div>

      {/* Credential env-var chips */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {data.envPresence.map((e) => (
          <span
            key={e.name}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${e.set ? "bg-lime/10 text-lime ring-lime/25" : "bg-white/[0.03] text-slate-500 ring-white/10"}`}
            title={e.set ? "set" : "not set"}
          >
            {e.name}
          </span>
        ))}
      </div>

      {data.configured ? (
        <div className="mt-2 space-y-1 text-xs text-slate-400">
          <p className="font-mono text-[11px] text-slate-500">
            {hc
              ? <>last check: <span className={STATUS_TONE[hc.status] ? "text-slate-300" : ""}>{hc.status}</span> · {new Date(hc.checkedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })}Z{hc.latencyMs != null ? ` · ${hc.latencyMs}ms` : ""}</>
              : "no health check recorded yet — run verification"}
          </p>
          {hc?.detail && <p className="font-mono text-[11px] text-slate-500">{hc.detail}</p>}
          {capabilities.length > 0 && (
            <p className="font-mono text-[11px] text-slate-400">
              verified reads: {capabilities.join(", ")}
            </p>
          )}
          {result?.detail && <p className="font-mono text-[11px] text-slate-500">{result.detail}</p>}
          {result && !result.configured && (
            <p className="font-mono text-[11px] text-amber-300">missing: {data.missing.join(", ")}</p>
          )}
          {result?.lastSuccessAt && (
            <p className="font-mono text-[11px] text-slate-600">last success: {new Date(result.lastSuccessAt).toLocaleString("en-US", { timeZone: "UTC" })}Z</p>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-1 text-xs text-slate-400">
          <p><span className="font-mono text-amber-300">requires_credentials</span> — missing: <span className="font-mono text-[11px]">{data.missing.join(", ") || "(none)"}</span></p>
          <p className="text-[11px] leading-relaxed text-slate-500">{data.requiredAction}</p>
        </div>
      )}

      {error && <p className="mt-2 font-mono text-xs text-red-300">{error}</p>}
    </section>
  );
}
