"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { OnboardingEvidence, OnboardingStep, StepState } from "@/app/api/system/kiosks/onboarding/evidence";

export type WizardDeviceOption = { id: string; label: string };

const STATE_STYLE: Record<StepState, { pill: string; label: string }> = {
  complete: { pill: "bg-lime/15 text-lime ring-lime/30", label: "complete" },
  in_progress: { pill: "bg-sky-400/15 text-sky-300 ring-sky-400/30", label: "in progress" },
  blocked: { pill: "bg-red-500/15 text-red-300 ring-red-400/30", label: "blocked" },
  awaiting_hardware: { pill: "bg-amber-400/15 text-amber-300 ring-amber-400/30", label: "awaiting hardware" },
};

const inputCls = "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100 focus:border-lime/50 focus:outline-none";
const labelCls = "mb-1 block text-[10px] font-extrabold uppercase tracking-wider text-slate-500";

/**
 * First-kiosk onboarding wizard UI. All mutations call the EXISTING endpoints —
 * this component never re-implements register/provision/diagnostics/
 * certification/status logic. Evidence refreshes via router.refresh() (the page
 * is a server component that re-reads the DB).
 */
export function OnboardingWizard({
  evidence,
  devices,
  venues,
  canManage,
  backendConfigured,
}: {
  evidence: OnboardingEvidence | null;
  devices: WizardDeviceOption[];
  venues: { id: string; label: string }[];
  canManage: boolean;
  backendConfigured: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmActivate, setConfirmActivate] = useState(false);
  const [justification, setJustification] = useState("");
  const [venuePick, setVenuePick] = useState("");

  const deviceId = evidence?.device.id ?? null;

  const call = async (key: string, path: string, init?: RequestInit, onOk?: (j: Record<string, unknown>) => void) => {
    setBusy(key); setError(null); setNotice(null);
    try {
      const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError((j.error as string) ?? `HTTP ${res.status}`);
        if (j.pending) setNotice("Change request created — awaiting approval before the transition applies.");
        return;
      }
      onOk?.(j);
      setNotice("Done — evidence refreshed.");
      router.refresh();
    } catch {
      setError("Request failed");
    } finally {
      setBusy(null);
    }
  };

  const post = (key: string, path: string, body: unknown, onOk?: (j: Record<string, unknown>) => void) =>
    call(key, path, { method: "POST", body: JSON.stringify(body) }, onOk);

  const copyToken = async () => {
    if (!issuedToken) return;
    try { await navigator.clipboard.writeText(issuedToken.token); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  const refresh = () => { setError(null); setNotice(null); router.refresh(); };

  /* ── No device selected ────────────────────────────────────────────────── */
  if (!evidence || !deviceId) {
    return (
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-6">
        <h2 className="eyebrow text-slate-400">Select a device</h2>
        <p className="mt-2 text-sm text-slate-400">
          Pick a registered kiosk to walk the 13-step onboarding checklist, or{" "}
          <Link href="/system/kiosks/register" className="text-lime underline">register a new one</Link> first.
        </p>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const id = String(new FormData(e.currentTarget).get("device") ?? "");
            if (id) router.push(`/system/kiosks/onboarding?device=${id}`);
          }}
        >
          <div className="min-w-[280px] flex-1">
            <label className={labelCls} htmlFor="device">Fleet device</label>
            <select id="device" name="device" className={inputCls} defaultValue="" required>
              <option value="" disabled>— choose a device —</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </div>
          <button type="submit" className="rounded-full bg-lime px-4 py-2 text-xs font-extrabold text-ink hover:bg-[#e6ffa8]">Load checklist</button>
        </form>
        <p className="mt-3 text-[10px] text-slate-500">
          Direct link: <code className="font-mono">/system/kiosks/onboarding?device=&lt;uuid&gt;</code>
        </p>
      </section>
    );
  }

  const d = evidence.device;
  const stepByKey = (k: string) => evidence.steps.find((s) => s.key === k);
  const activation = stepByKey("activation");
  const activationReady = activation?.meta?.activation_ready === true;
  const legalTargets = (activation?.meta?.legal_targets as string[] | undefined) ?? [];

  const transition = (target: string) =>
    post(`status:${target}`, `/api/system/kiosks/${deviceId}/status`, {
      status: target,
      justification: justification.trim() || `Onboarding wizard transition → ${target}`,
    });

  /* ── Per-step action surfaces ──────────────────────────────────────────── */
  const stepActions = (step: OnboardingStep) => {
    if (!canManage && step.key !== "redeem") {
      return <p className="text-[10px] text-slate-500">Requires system.kiosks.manage for actions on this step.</p>;
    }
    switch (step.key) {
      case "register":
        return (
          <p className="text-[10px] text-slate-500">
            Registered via <Link href="/system/kiosks/register" className="text-lime underline">/system/kiosks/register</Link> or{" "}
            <code className="font-mono">POST /api/system/kiosks/register</code>. To onboard another device, pick it above.
          </p>
        );
      case "provision_token": {
        const ts = step.meta?.token_state as string | undefined;
        return (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy !== null} onClick={() =>
                post("issue-token", `/api/system/kiosks/${deviceId}/provision`, {}, (j) => {
                  const t = j.token as string | undefined;
                  const e = j.expires_at as string | undefined;
                  if (t) setIssuedToken({ token: t, expiresAt: e ?? "" });
                })}
                className="rounded-full bg-lime px-3 py-1.5 font-mono text-[11px] font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
                {busy === "issue-token" ? "Issuing…" : ts === "issued" || ts === "used" ? "Re-issue token" : "Issue provisioning token"}
              </button>
              {(ts === "issued" || ts === "expired") && (
                <button type="button" disabled={busy !== null} onClick={() => post("revoke-token", `/api/system/kiosks/${deviceId}/provision/revoke`, {})}
                  className="rounded-full bg-red-500/15 px-3 py-1.5 font-mono text-[11px] font-extrabold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-50">
                  Revoke
                </button>
              )}
            </div>
            {issuedToken && (
              <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3">
                <p className="text-xs font-bold text-amber-300">⚠ Token shown once — copy it now. Only its hash is stored.</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-lime">{issuedToken.token}</code>
                  <button type="button" onClick={copyToken} className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
                    {copied ? "copied" : "copy"}
                  </button>
                </div>
                <p className="mt-1 font-mono text-[10px] text-amber-200/70">expires: {issuedToken.expiresAt || "72h from issue"} · single-use</p>
              </div>
            )}
          </div>
        );
      }
      case "redeem":
        return (
          <div className="space-y-2 text-[11px] text-slate-400">
            <p>
              The wizard cannot redeem on behalf of hardware. On the gateway/device, POST to{" "}
              <code className="font-mono text-lime">/api/devices/provision</code> with{" "}
              <code className="font-mono">{"{ token, device_uid?, serial_number?, gateway_id? }"}</code> — the response
              returns the device secret <strong>once</strong>. Then press refresh to pick up{" "}
              <code className="font-mono">provision_token_used_at</code> / <code className="font-mono">credential_issued_at</code>.
            </p>
            <button type="button" onClick={refresh} className="rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
              Check redemption status
            </button>
          </div>
        );
      case "diagnostics":
        return (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy !== null} onClick={() => post("diagnostics", `/api/system/kiosks/${deviceId}/diagnostics`, {})}
              className="rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50">
              {busy === "diagnostics" ? "Running…" : "Run diagnostics"}
            </button>
            <Link href={`/system/kiosks/${deviceId}`} className="text-[11px] text-lime underline">Device detail / history →</Link>
          </div>
        );
      case "certification":
        return (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy !== null} onClick={() =>
                post("suite", "/api/system/kiosks/certification", { action: "run_suite", tier: "simulated", device_id: deviceId })}
                className="rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50">
                {busy === "suite" ? "Running…" : "Run simulated suite"}
              </button>
              <Link href="/system/kiosks/certification" className="text-[11px] text-lime underline">Certification console →</Link>
            </div>
            <p className="text-[10px] text-slate-500">
              Simulated results are software-contract evidence only — labeled, never physical verification. Physical-tier
              runs require real hardware and a fresh step-up elevation (enforced by the certification API).
            </p>
          </div>
        );
      case "venue":
        return (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px]">
              <label className={labelCls} htmlFor={`venue-${step.key}`}>Assign venue</label>
              <select id={`venue-${step.key}`} className={inputCls} value={venuePick} onChange={(e) => setVenuePick(e.target.value)}>
                <option value="">— choose venue —</option>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
            <button type="button" disabled={busy !== null || !venuePick} onClick={() =>
              post("venue", "/api/system/kiosks/onboarding", { action: "assign_venue", device_id: deviceId, venue_id: venuePick })}
              className="rounded-full bg-lime px-3 py-2 text-xs font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
              {busy === "venue" ? "Assigning…" : "Assign"}
            </button>
          </div>
        );
      case "activation": {
        if (d.status === "active") return <p className="text-[10px] text-lime">Device already active.</p>;
        return (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {legalTargets.map((t) => (
                <button key={t} type="button" disabled={busy !== null || (t === "active" && !activationReady)}
                  title={t === "active" && !activationReady ? "All prior evidence steps must be green first" : undefined}
                  onClick={() => transition(t)}
                  className={`rounded-full px-3 py-1.5 font-mono text-[11px] font-extrabold ring-1 disabled:opacity-40 ${
                    t === "active" ? "bg-lime text-ink ring-lime hover:bg-[#e6ffa8]" : "bg-white/10 text-slate-200 ring-white/15 hover:bg-white/15"
                  }`}>
                  {busy === `status:${t}` ? "…" : `→ ${t}`}
                </button>
              ))}
              {legalTargets.length === 0 && <p className="text-[10px] text-slate-500">No legal transitions from '{d.status}'.</p>}
            </div>
            {activationReady && (
              <div className="rounded-xl border border-lime/30 bg-lime/10 p-3">
                <label className="flex items-start gap-2 text-xs text-slate-200">
                  <input type="checkbox" checked={confirmActivate} onChange={(e) => setConfirmActivate(e.target.checked)} className="mt-0.5" />
                  <span>I confirm all onboarding evidence is green and this device is ready for production.</span>
                </label>
                <input value={justification} onChange={(e) => setJustification(e.target.value)} maxLength={2000}
                  placeholder="Justification (optional — audited)" className={`${inputCls} mt-2 font-mono text-xs`} />
                <button type="button" disabled={busy !== null || !confirmActivate}
                  onClick={() => transition("active")}
                  className="mt-2 rounded-full bg-lime px-4 py-2 text-xs font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
                  {busy === "status:active" ? "Activating…" : "Activate kiosk"}
                </button>
                <p className="mt-1 text-[10px] text-slate-400">
                  Goes through <code className="font-mono">POST /api/system/kiosks/[id]/status</code> — illegal edges 409,
                  high-risk targets need an approved change request, every transition is audited.
                </p>
              </div>
            )}
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header card */}
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-sm font-bold text-white">{d.device_uid ?? d.id.slice(0, 8)}</p>
            <p className="mt-0.5 font-mono text-[11px] text-slate-400">
              {d.manufacturer ?? "?"} {d.model ?? ""} · serial {d.serial_number ?? "—"} ·{" "}
              <span className="text-slate-300">{d.status}</span> · venue {d.venue_label ?? "unassigned"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ring-1 ${evidence.all_prior_green ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-300 ring-white/15"}`}>
              {evidence.all_prior_green ? "all prior steps green" : "onboarding incomplete"}
            </span>
            <button type="button" onClick={refresh} className="rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
              Refresh evidence
            </button>
            <Link href={`/system/kiosks/${deviceId}`} className="text-[11px] text-lime underline">Device detail →</Link>
          </div>
        </div>
        {error && <p className="mt-3 font-mono text-xs text-red-300">{error}</p>}
        {notice && <p className="mt-3 font-mono text-xs text-lime">{notice}</p>}
        {!backendConfigured && <p className="mt-3 text-xs text-amber-300">Backend not configured.</p>}
      </section>

      {/* Steps */}
      <ol className="space-y-3">
        {evidence.steps.map((step, i) => {
          const st = STATE_STYLE[step.state];
          return (
            <li key={step.key} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Step {i + 1}</p>
                  <h2 className="mt-0.5 font-display text-base font-bold text-white">{step.title}</h2>
                  <p className="mt-1 text-xs text-slate-400">{step.summary}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ring-1 ${st.pill}`}>{st.label}</span>
              </div>
              {step.evidence.length > 0 && (
                <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {step.evidence.map((ev) => (
                    <div key={ev.label} className="flex items-baseline justify-between gap-3 border-b border-white/5 py-1">
                      <dt className="shrink-0 font-mono text-[10px] text-slate-500">{ev.label}</dt>
                      <dd className="truncate text-right font-mono text-[11px] text-slate-300" title={ev.value}>{ev.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="mt-3">{stepActions(step)}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
