"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 15_000;
const UUID_RE = /^[0-9a-f-]{36}$/i;

type MonitorData = {
  state: string | null;
  providerStateRaw: string | null;
  terminal: boolean;
  requestStatus: string | null;
  health: { status: string; checkedAt: string; httpStatus: number | null; url: string | null; detail: string | null } | null;
  error: string | null;
};

const STATE_TONE: Record<string, string> = {
  ready: "bg-lime/15 text-lime ring-lime/30",
  building: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  queued: "bg-sky-400/10 text-sky-300/80 ring-sky-400/20",
  pending: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  awaiting_manual: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  error: "bg-red-500/15 text-red-300 ring-red-400/30",
  canceled: "bg-white/10 text-slate-400 ring-white/15",
  unknown: "bg-white/10 text-slate-400 ring-white/15",
};

const HEALTH_TONE: Record<string, string> = {
  healthy: "bg-lime/15 text-lime ring-lime/30",
  unhealthy: "bg-red-500/15 text-red-300 ring-red-400/30",
  skipped: "bg-white/10 text-slate-400 ring-white/15",
  unknown: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
};

/**
 * Live deployment status poller for the deployment detail page.
 * Polls GET /api/system/deployments/[id]/monitor every 15s and STOPS on a
 * terminal provider state (ready/error/canceled) or when there is nothing
 * left to monitor. One provider read per poll — never blocks the server.
 * Refreshes the server component (build events etc.) only when the mapped
 * state or health result actually changes.
 */
export function DeploymentMonitor({ id, initialHealth }: { id: string; initialHealth?: MonitorData["health"] }) {
  const router = useRouter();
  const isRequest = UUID_RE.test(id);
  const [data, setData] = useState<MonitorData | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const prevSig = useRef<string>("");
  const terminalRef = useRef(false);

  const apply = useCallback((d: MonitorData) => {
    terminalRef.current = d.terminal === true;
    const sig = `${d.state}|${d.providerStateRaw}|${d.health?.status ?? ""}|${d.health?.httpStatus ?? ""}|${d.requestStatus}`;
    setData(d);
    if (sig !== prevSig.current) {
      prevSig.current = sig;
      router.refresh();
    }
  }, [router]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/system/deployments/${encodeURIComponent(id)}/monitor`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok) apply(j as MonitorData);
    } catch {
      /* transient network error — next tick retries */
    }
  }, [id, apply]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    terminalRef.current = false;
    const tick = async () => {
      if (terminalRef.current) return;
      await poll();
      if (!stopped && !terminalRef.current) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [id, poll]);

  const runHealthCheck = async () => {
    if (!isRequest) return;
    setBusy(true); setManualError(null);
    try {
      const res = await fetch(`/api/system/deployments/${encodeURIComponent(id)}/health-check`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setManualError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      else if ((j as { health?: MonitorData["health"] }).health) {
        apply({ ...(data ?? { state: null, providerStateRaw: null, terminal: false, requestStatus: null, health: null, error: null }), health: (j as { health: MonitorData["health"] }).health });
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const terminal = data?.terminal === true || terminalRef.current;
  const health = data?.health ?? initialHealth ?? null;
  const state = data?.state ?? null;

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="eyebrow text-slate-400">Live status</h2>
        <div className="flex items-center gap-2">
          {state && (
            <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ring-1 ${STATE_TONE[state] ?? STATE_TONE.unknown}`}>
              {state}{data?.providerStateRaw && data.providerStateRaw !== state ? ` (${data.providerStateRaw})` : ""}
            </span>
          )}
          {health && (
            <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ring-1 ${HEALTH_TONE[health.status] ?? HEALTH_TONE.unknown}`}>
              health: {health.status}{health.httpStatus != null ? ` · HTTP ${health.httpStatus}` : ""}
            </span>
          )}
          {terminal && <span className="font-mono text-[10px] text-slate-500">terminal — polling stopped</span>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        <span>polls every {POLL_MS / 1000}s{terminal ? " (stopped)" : ""}</span>
        {health?.checkedAt && <span>health checked {new Date(health.checkedAt).toLocaleString("en-US", { timeZone: "UTC" })}Z</span>}
        {health?.url && <span className="font-mono">{health.url}</span>}
        {isRequest && (
          <button
            type="button"
            disabled={busy}
            onClick={runHealthCheck}
            className="rounded-full bg-white/10 px-3 py-1 font-mono text-[10px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
          >
            {busy ? "checking…" : "run health check"}
          </button>
        )}
      </div>
      {(data?.error || manualError) && (
        <p className="mt-2 font-mono text-xs text-amber-300">{manualError ?? data?.error}</p>
      )}
      {health?.detail && <p className="mt-1 font-mono text-[11px] text-slate-500">{health.detail}</p>}
    </section>
  );
}
