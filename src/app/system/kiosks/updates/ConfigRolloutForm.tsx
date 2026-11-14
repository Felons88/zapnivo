"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const ALLOWED_KEYS = ["heartbeat_interval_sec", "maintenance_mode", "ad_playlist_id", "brightness", "config_notes"];

export type ConfigReleaseOption = { id: string; label: string };

/**
 * Config rollout proposal form. Posts to /api/system/updates/config.
 * Client-side validation is intentionally LIGHT (JSON parses, keys look
 * whitelisted) — the server re-validates via validateDesiredConfig.
 */
export default function ConfigRolloutForm({ releases, canManage }: { releases: ConfigReleaseOption[]; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [releaseId, setReleaseId] = useState("");
  const [configText, setConfigText] = useState(JSON.stringify({ brightness: 80 }, null, 2));
  const [deviceText, setDeviceText] = useState("");
  const [justification, setJustification] = useState("");

  if (!canManage) {
    return (
      <div className="rounded-xl border border-white/[0.08] bg-black/20 p-3">
        <p className="font-mono text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Propose config rollout</p>
        <p className="mt-2 text-xs text-slate-500">system.kiosks.manage required to propose rollouts.</p>
      </div>
    );
  }

  const post = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/system/updates/config", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 202) {
        setNotice(`Change request ${(j as { changeRequestId?: string }).changeRequestId?.slice(0, 8) ?? ""} pending approval`);
      } else if (!res.ok) {
        setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      } else if (body.action === "propose") {
        const r = j as { mode?: string; summary?: Record<string, number> };
        setNotice(`rollout proposed (${r.mode ?? "?"}): ${JSON.stringify(r.summary ?? {})}`);
      } else {
        setNotice(`done: ${JSON.stringify(j).slice(0, 200)}`);
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const propose = () => {
    let config: unknown;
    try { config = JSON.parse(configText); } catch { setError("config is not valid JSON"); return; }
    if (config == null || typeof config !== "object" || Array.isArray(config)) { setError("config must be a JSON object"); return; }
    const keys = Object.keys(config as Record<string, unknown>);
    const bad = keys.filter((k) => !ALLOWED_KEYS.includes(k));
    if (bad.length > 0) { setError(`unknown config keys: ${bad.join(", ")} — allowed: ${ALLOWED_KEYS.join(", ")}`); return; }
    const deviceIds = deviceText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (deviceIds.length === 0) { setError("device_ids is required (one uuid per line or comma-separated)"); return; }
    if (deviceIds.length > 50) { setError("max 50 devices per rollout"); return; }
    void post("propose", {
      action: "propose",
      config,
      device_ids: deviceIds,
      ...(releaseId ? { release_id: releaseId } : {}),
      ...(justification.trim() ? { justification: justification.trim() } : {}),
    });
  };

  const dispatch = () => {
    const deviceIds = deviceText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (deviceIds.length === 0) { setError("device_ids is required"); return; }
    void post("dispatch", { action: "dispatch", device_ids: deviceIds });
  };

  const refresh = () => void post("refresh", { action: "refresh" });

  return (
    <div className="rounded-xl border border-white/[0.08] bg-black/20 p-3">
      <p className="mb-2 font-mono text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
        Propose config rollout — allowed keys: {ALLOWED_KEYS.join(", ")}
      </p>

      <label className="mb-2 block">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500">Link config release (optional)</span>
        <select
          value={releaseId}
          onChange={(e) => setReleaseId(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200"
        >
          <option value="">standalone (no release link)</option>
          {releases.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </label>

      <label className="mb-2 block">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500">Desired config (JSON)</span>
        <textarea
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          rows={4}
          spellCheck={false}
          className="w-full rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] text-slate-200"
        />
      </label>

      <label className="mb-2 block">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500">Device ids (uuid, one per line or comma-separated)</span>
        <textarea
          value={deviceText}
          onChange={(e) => setDeviceText(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="11111111-1111-4111-8111-111111111111"
          className="w-full rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] text-slate-200"
        />
      </label>

      <label className="mb-2 block">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-slate-500">Justification (optional)</span>
        <input
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          maxLength={500}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null} onClick={propose}
          className="rounded-full bg-lime px-3 py-1 text-[11px] font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
          {busy === "propose" ? "…" : "Propose rollout"}
        </button>
        <button type="button" disabled={busy !== null} onClick={dispatch}
          className="rounded-full bg-amber-400/15 px-3 py-1 text-[11px] font-bold text-amber-300 ring-1 ring-amber-400/30 hover:bg-amber-400/25 disabled:opacity-50">
          {busy === "dispatch" ? "…" : "Dispatch approved revisions"}
        </button>
        <button type="button" disabled={busy !== null} onClick={refresh}
          className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50">
          {busy === "refresh" ? "…" : "Re-sync target states"}
        </button>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">
        propose creates device_config_revisions (draft→approved; change-request gated by risk)
        and queues kiosk_update_targets when a campaign exists. dispatch uses the resolved
        gateway adapter — with KIOSK_ADAPTER=none it records adapter_disabled failures honestly.
        Bulk (&gt;10 devices) or medium-risk rollouts require step-up elevation.
      </p>

      {error && <p className="mt-2 font-mono text-[11px] text-red-300">{error}</p>}
      {notice && <p className="mt-2 font-mono text-[11px] text-lime">{notice}</p>}
    </div>
  );
}
