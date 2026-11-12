"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  CERTIFICATION_STATUSES, CERTIFICATION_TIERS,
  checksForTier, type CertificationStatus, type CertificationTier,
} from "./checklist";

export type ConsoleDevice = {
  id: string;
  label: string;
  serial_number: string | null;
  status: string;
};

export type ConsoleRun = {
  id: string;
  device_id: string | null;
  tier: CertificationTier;
  check_key: string;
  status: CertificationStatus;
  detail: unknown;
  actor_id: string | null;
  created_at: string;
  record_hash: string;
  prev_hash: string | null;
};

const TIER_TONE: Record<CertificationTier, string> = {
  simulated: "bg-slate-400/15 text-slate-300 ring-slate-400/30",
  gateway_contract: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  physical: "bg-lime/15 text-lime ring-lime/30",
};

const STATUS_TONE: Record<CertificationStatus, string> = {
  pass: "bg-lime/15 text-lime ring-lime/30",
  fail: "bg-red-500/15 text-red-300 ring-red-400/30",
  blocked: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  skipped: "bg-white/10 text-slate-400 ring-white/15",
};

const TIER_LABEL: Record<CertificationTier, string> = {
  simulated: "Simulated",
  gateway_contract: "Gateway contract",
  physical: "Physical",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z";

const inputCls =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 outline-none focus:border-lime/50";

type SuiteCheckResult = {
  check_key: string;
  tier: CertificationTier;
  status: CertificationStatus;
  recorded: boolean;
  record_hash?: string;
};
type SuiteResponse = {
  ok: boolean;
  refused?: boolean;
  refusal_reason?: string;
  suite_run_id: string;
  device_id: string | null;
  simulated: true;
  recorded: number;
  results: SuiteCheckResult[];
};

export function CertificationConsole({
  devices, runs: initialRuns, canManage, backendConfigured, loadError,
}: {
  devices: ConsoleDevice[];
  runs: ConsoleRun[];
  canManage: boolean;
  backendConfigured: boolean;
  loadError: string | null;
}) {
  const router = useRouter();
  const [runs, setRuns] = useState<ConsoleRun[]>(initialRuns);
  const [tierFilter, setTierFilter] = useState<string>("");
  const [deviceFilter, setDeviceFilter] = useState<string>("");

  // Automated suite state
  const [suiteDeviceId, setSuiteDeviceId] = useState("");
  const [suiteBusy, setSuiteBusy] = useState(false);
  const [suiteMsg, setSuiteMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [suiteResults, setSuiteResults] = useState<SuiteCheckResult[] | null>(null);
  const [suiteRunId, setSuiteRunId] = useState<string | null>(null);

  // Recorder state
  const [deviceId, setDeviceId] = useState("");
  const [tier, setTier] = useState<CertificationTier>("simulated");
  const [checkKey, setCheckKey] = useState<string>(checksForTier("simulated")[0]?.key ?? "");
  const [status, setStatus] = useState<CertificationStatus>("pass");
  const [detailText, setDetailText] = useState("");
  const [busy, setBusy] = useState(false);
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const deviceLabel = useMemo(() => {
    const m = new Map(devices.map((d) => [d.id, d.label]));
    return (id: string | null) => (id ? m.get(id) ?? `${id.slice(0, 8)}…` : "fleet-level");
  }, [devices]);

  // Latest run per check_key (any device) for the checklist status column.
  const latestByCheck = useMemo(() => {
    const m = new Map<string, ConsoleRun>();
    for (const r of runs) {
      const cur = m.get(r.check_key);
      if (!cur || r.created_at > cur.created_at) m.set(r.check_key, r);
    }
    return m;
  }, [runs]);

  const filteredRuns = useMemo(
    () => runs.filter((r) =>
      (!tierFilter || r.tier === tierFilter) &&
      (!deviceFilter || (deviceFilter === "fleet" ? r.device_id === null : r.device_id === deviceFilter))
    ),
    [runs, tierFilter, deviceFilter],
  );

  const tierChecks = checksForTier(tier);

  async function submitRun(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormMsg(null);
    let detail: Record<string, unknown> | undefined;
    const trimmed = detailText.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be a JSON object");
        detail = parsed as Record<string, unknown>;
      } catch (err) {
        setBusy(false);
        setFormMsg({ ok: false, text: `detail is not valid JSON: ${err instanceof Error ? err.message : "parse error"}` });
        return;
      }
    }
    try {
      const res = await fetch("/api/system/kiosks/certification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_id: deviceId || null,
          tier,
          check_key: checkKey,
          status,
          ...(detail ? { detail } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = (json as { code?: string }).code;
        setFormMsg({
          ok: false,
          text: code === "step_up_required"
            ? "Step-up verification required — confirm with MFA (security → MFA & step-up) before recording physical-tier results."
            : `Error ${res.status}: ${(json as { error?: string }).error ?? "request failed"}`,
        });
        return;
      }
      const run = (json as { run: ConsoleRun }).run;
      setRuns((prev) => [run, ...prev]);
      setFormMsg({ ok: true, text: `Recorded ${run.check_key} → ${run.status} · hash ${run.record_hash.slice(0, 12)}… (prev ${run.prev_hash ? run.prev_hash.slice(0, 12) + "…" : "genesis"})` });
    } catch {
      setFormMsg({ ok: false, text: "Network error — run not recorded." });
    } finally {
      setBusy(false);
    }
  }

  async function runSuite() {
    if (suiteBusy) return;
    setSuiteBusy(true);
    setSuiteMsg(null);
    setSuiteResults(null);
    try {
      const res = await fetch("/api/system/kiosks/certification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run_suite", tier: "simulated", ...(suiteDeviceId ? { device_id: suiteDeviceId } : {}) }),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<SuiteResponse> & { error?: string; code?: string };
      if (!res.ok && res.status !== 207) {
        setSuiteMsg({ ok: false, text: `Error ${res.status}: ${json.error ?? "suite failed"}` });
        return;
      }
      const suite = json as SuiteResponse;
      setSuiteResults(suite.results ?? []);
      setSuiteRunId(suite.suite_run_id ?? null);
      const fails = (suite.results ?? []).filter((r) => r.status === "fail").length;
      const blockedN = (suite.results ?? []).filter((r) => r.status === "blocked").length;
      setSuiteMsg({
        ok: suite.ok !== false,
        text: `Suite ${suite.suite_run_id?.slice(0, 8)}… — ${suite.recorded ?? 0} runs recorded` +
          (fails ? `, ${fails} FAILED` : "") + (blockedN ? `, ${blockedN} blocked` : "") +
          ". All results are simulated-tier software-contract evidence.",
      });
      router.refresh(); // reload the runs table from the server
    } catch {
      setSuiteMsg({ ok: false, text: "Network error — suite did not complete." });
    } finally {
      setSuiteBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header + honesty statement */}
      <div>
        <p className="eyebrow text-lime">Kiosk Infrastructure</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Hardware certification</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Certification run ledger (<code className="font-mono text-xs">system_certification_runs</code>, migration 0051).
          Each run is hash-chained per device+tier for tamper evidence.{" "}
          <span className="font-semibold text-amber-300">
            Simulated and gateway-contract results verify software contracts only — they are NOT physical
            hardware verification. Physical-tier runs require step-up MFA and a real device; nothing on
            this page claims hardware verification that has not happened.
          </span>
        </p>
      </div>

      {!backendConfigured && (
        <p className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          Backend not configured — certification ledger unavailable (runs cannot be recorded or displayed).
        </p>
      )}
      {loadError && (
        <p className="rounded-xl border border-red-400/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          Failed to load certification data: {loadError}
        </p>
      )}

      {/* Checklist grouped by tier */}
      <section className="space-y-4">
        <h2 className="font-display text-lg font-bold text-white">Certification checklist</h2>
        {CERTIFICATION_TIERS.map((t) => {
          const checks = checksForTier(t);
          return (
            <div key={t} className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03]">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                <p className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
                  {TIER_LABEL[t]}
                  <span className={`ml-2 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${TIER_TONE[t]}`}>{t}</span>
                </p>
                <p className="text-[11px] text-slate-500">
                  {t === "physical" ? "requires elevation + real device" : t === "gateway_contract" ? "gateway protocol evidence" : "software contract evidence"}
                </p>
              </div>
              <table className="w-full text-left text-xs">
                <tbody>
                  {checks.map((c) => {
                    const latest = latestByCheck.get(c.key);
                    return (
                      <tr key={c.key} className="border-b border-white/5 last:border-0">
                        <td className="px-4 py-2.5">
                          <p className="font-mono font-bold text-slate-200">{c.key}</p>
                          <p className="mt-0.5 text-slate-400">{c.label}</p>
                          {c.note && <p className="mt-0.5 text-[11px] text-amber-300/80">{c.note}</p>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-[11px] text-slate-500">
                          {c.automated ? `automated${c.evidence ? ` · ${c.evidence}` : ""}` : c.needsHardware ? "manual — needs hardware" : "manual"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">
                          {latest ? (
                            <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATUS_TONE[latest.status]}`}>
                              {latest.status}
                            </span>
                          ) : (
                            <span className="font-mono text-[10px] text-slate-600">no runs</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </section>

      {/* Automated suite runner */}
      {canManage && backendConfigured && (
        <section className="rounded-2xl border border-lime/20 bg-lime/[0.04] p-5">
          <h2 className="font-display text-lg font-bold text-white">Run simulated suite</h2>
          <p className="mt-1 text-xs text-slate-400">
            Executes the automated checks against the real device-auth, provisioning, ingest and
            command libs via the kiosk simulator, then records each result into the same
            hash-chained ledger. With no device selected a fresh <code className="font-mono">sim-</code>{" "}
            namespace device is provisioned for the run. Select an existing{" "}
            <span className="font-semibold text-lime">simulator-marked</span> device to bind results to it —
            physical devices are refused. Physical-tier checks are never automated.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <select className={inputCls + " w-auto"} value={suiteDeviceId} onChange={(e) => setSuiteDeviceId(e.target.value)} aria-label="Suite device">
              <option value="">auto — create sim device</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>{d.label}{d.serial_number ? ` · ${d.serial_number}` : ""}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={runSuite}
              disabled={suiteBusy}
              className="rounded-full bg-lime px-5 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8] disabled:opacity-50"
            >
              {suiteBusy ? "Running suite…" : "Run simulated suite"}
            </button>
            {suiteMsg && (
              <p className={`text-xs ${suiteMsg.ok ? "text-lime" : "text-red-300"}`}>{suiteMsg.text}</p>
            )}
          </div>
          {suiteResults && suiteResults.length > 0 && (
            <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{["Tier", "Check", "Status", "Recorded"].map((h) => (
                    <th key={h} className="px-3 py-2 font-extrabold">{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {suiteResults.map((r) => (
                    <tr key={`${r.tier}:${r.check_key}`} className="border-b border-white/5 last:border-0">
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${TIER_TONE[r.tier]}`}>{r.tier}</span>
                      </td>
                      <td className="px-3 py-2 font-mono font-bold text-slate-200">{r.check_key}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATUS_TONE[r.status]}`}>{r.status}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-400">{r.recorded ? (r.record_hash ? `${r.record_hash.slice(0, 10)}…` : "yes") : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {suiteRunId && (
            <p className="mt-2 font-mono text-[10px] text-slate-600">suite_run_id {suiteRunId} — group filter via run detail.suite_run_id</p>
          )}
        </section>
      )}

      {/* Run recorder */}
      {canManage && backendConfigured && (
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-5">
          <h2 className="font-display text-lg font-bold text-white">Record a run</h2>
          <p className="mt-1 text-xs text-slate-500">
            Records a result into the hash-chained ledger. Physical-tier records require a live step-up
            elevation (MFA) — the API returns <code className="font-mono">step_up_required</code> otherwise.
            Credential-shaped keys in <code className="font-mono">detail</code> are stripped before storage.
          </p>
          <form onSubmit={submitRun} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="block">
              <span className="mb-1 block text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Device</span>
              <select className={inputCls} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                <option value="">fleet-level (no device)</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}{d.serial_number ? ` · ${d.serial_number}` : ""}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Tier</span>
              <select
                className={inputCls}
                value={tier}
                onChange={(e) => {
                  const t = e.target.value as CertificationTier;
                  setTier(t);
                  const first = checksForTier(t)[0];
                  if (first) setCheckKey(first.key);
                }}
              >
                {CERTIFICATION_TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Check</span>
              <select className={inputCls} value={checkKey} onChange={(e) => setCheckKey(e.target.value)}>
                {tierChecks.map((c) => <option key={c.key} value={c.key}>{c.key}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Status</span>
              <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as CertificationStatus)}>
                {CERTIFICATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Detail (JSON, optional)</span>
              <input
                className={inputCls}
                value={detailText}
                onChange={(e) => setDetailText(e.target.value)}
                placeholder='{"note":"suite output ref"}'
              />
            </label>
            <div className="sm:col-span-2 lg:col-span-5 flex items-center gap-3">
              <button
                type="submit"
                disabled={busy || !checkKey}
                className="rounded-full bg-lime px-5 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8] disabled:opacity-50"
              >
                {busy ? "Recording…" : "Record run"}
              </button>
              {formMsg && (
                <p className={`text-xs ${formMsg.ok ? "text-lime" : "text-red-300"}`}>{formMsg.text}</p>
              )}
            </div>
          </form>
        </section>
      )}
      {!canManage && (
        <p className="text-xs text-slate-500">
          Read-only: your system role can view runs but not record them (requires <code className="font-mono">system.kiosks.manage</code>).
        </p>
      )}

      {/* Runs table */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-bold text-white">Runs</h2>
          <div className="flex flex-wrap gap-2">
            <select className={inputCls + " w-auto"} value={tierFilter} onChange={(e) => setTierFilter(e.target.value)} aria-label="Filter by tier">
              <option value="">all tiers</option>
              {CERTIFICATION_TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
            </select>
            <select className={inputCls + " w-auto"} value={deviceFilter} onChange={(e) => setDeviceFilter(e.target.value)} aria-label="Filter by device">
              <option value="">all devices + fleet</option>
              <option value="fleet">fleet-level only</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05]">
          {filteredRuns.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">
              No certification runs recorded{tierFilter || deviceFilter ? " matching these filters" : " yet"}.
              Runs appear here only when recorded through the API — nothing is pre-populated or fabricated.
            </p>
          ) : (
            <table className="w-full min-w-[1000px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Timestamp", "Device", "Tier", "Check", "Status", "Actor", "Record hash", "Prev hash"].map((h) => (
                  <th key={h} className="px-4 py-3 font-extrabold">{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {filteredRuns.map((r) => (
                  <tr key={r.id} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{when(r.created_at)}</td>
                    <td className="px-4 py-3 font-mono text-slate-300">{deviceLabel(r.device_id)}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${TIER_TONE[r.tier] ?? ""}`}>{r.tier}</span>
                    </td>
                    <td className="px-4 py-3 font-mono font-bold text-slate-200">{r.check_key}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATUS_TONE[r.status] ?? ""}`}>{r.status}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-400">{r.actor_id ? `${r.actor_id.slice(0, 8)}…` : "—"}</td>
                    <td className="px-4 py-3 font-mono text-slate-400" title={r.record_hash}>{r.record_hash.slice(0, 12)}…</td>
                    <td className="px-4 py-3 font-mono text-slate-500" title={r.prev_hash ?? "genesis"}>{r.prev_hash ? `${r.prev_hash.slice(0, 12)}…` : "genesis"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="text-[11px] text-slate-600">
          Hash chain: each run&apos;s <code className="font-mono">prev_hash</code> is the previous run&apos;s{" "}
          <code className="font-mono">record_hash</code> within the same device+tier chain — edits or deletions
          break the chain (verify via <code className="font-mono">verifyCertificationChain</code>).
        </p>
      </section>
    </div>
  );
}
