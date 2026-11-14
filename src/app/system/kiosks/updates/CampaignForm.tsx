"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { UpdateReleaseRow } from "@/lib/system/update-rollouts";

/**
 * Create-campaign form. Posts to /api/system/updates/campaigns; the server
 * resolves targets, enforces the approved-release rule, and lands the campaign
 * in 'pending_approval' (a DIFFERENT operator must approve it).
 */
export function CampaignForm({ releases }: { releases: UpdateReleaseRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [releaseId, setReleaseId] = useState("");
  const [name, setName] = useState("");
  const [justification, setJustification] = useState("");
  const [deviceIds, setDeviceIds] = useState("");
  const [models, setModels] = useState("");
  const [regions, setRegions] = useState("");
  const [canary, setCanary] = useState("");
  const [concurrency, setConcurrency] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (releases.length === 0) {
    return (
      <p className="max-w-xs rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-slate-500">
        No approved releases — approve a release in the registry above before creating a campaign.
      </p>
    );
  }

  const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const uuidCsv = (s: string) => csv(s).filter((x) => /^[0-9a-f-]{36}$/i.test(x));

  const submit = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const target_filter: Record<string, unknown> = {};
      const ids = uuidCsv(deviceIds);
      const m = csv(models), r = csv(regions);
      const c = canary.trim() ? Number(canary) : null;
      if (ids.length) target_filter.device_ids = ids;
      if (m.length) target_filter.models = m;
      if (r.length) target_filter.regions = r;
      if (c != null && Number.isFinite(c)) target_filter.canary_percent = Math.min(100, Math.max(1, Math.round(c)));

      const res = await fetch("/api/system/updates/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          release_id: releaseId,
          name: name.trim(),
          justification: justification.trim(),
          target_filter,
          concurrency_limit: Math.min(50, Math.max(1, parseInt(concurrency, 10) || 1)),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const ex = (j as { excluded?: { reason: string }[] }).excluded;
        setError(`${(j as { error?: string }).error ?? `HTTP ${res.status}`}${ex?.length ? ` (${ex.length} devices excluded)` : ""}`);
        return;
      }
      const camp = (j as { campaign?: { name?: string }; target_count?: number }).campaign;
      setNote(`created "${camp?.name ?? "?"}" — ${j.target_count ?? "?"} targets, pending approval`);
      setOpen(false); setName(""); setJustification(""); setDeviceIds(""); setModels(""); setRegions(""); setCanary("");
      router.refresh();
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="rounded-full bg-lime/15 px-4 py-2 font-mono text-[11px] font-extrabold text-lime ring-1 ring-lime/30 hover:bg-lime/25">
        + New campaign
      </button>
    );
  }

  const input = "w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-slate-200 focus:border-lime/50 focus:outline-none";
  return (
    <div className="w-full max-w-2xl space-y-2 rounded-xl border border-lime/25 bg-black/30 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-lime">New update campaign</h3>
        <button type="button" onClick={() => setOpen(false)} className="font-mono text-[10px] text-slate-500 hover:text-slate-300">close</button>
      </div>
      <select value={releaseId} onChange={(e) => setReleaseId(e.target.value)} className={input}>
        <option value="">— select approved release —</option>
        {releases.map((r) => (
          <option key={r.id} value={r.id}>{r.kind} {r.version} ({r.channel}){r.model ? ` · ${r.model}` : ""}</option>
        ))}
      </select>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" className={input} maxLength={200} />
      <textarea value={justification} onChange={(e) => setJustification(e.target.value)} placeholder="Justification (required for approval review)" className={input} rows={2} maxLength={4000} />
      <div className="grid grid-cols-2 gap-2">
        <input value={deviceIds} onChange={(e) => setDeviceIds(e.target.value)} placeholder="device_ids (uuid, csv)" className={input} />
        <input value={models} onChange={(e) => setModels(e.target.value)} placeholder="models (csv)" className={input} />
        <input value={regions} onChange={(e) => setRegions(e.target.value)} placeholder="regions (csv)" className={input} />
        <input value={canary} onChange={(e) => setCanary(e.target.value)} placeholder="canary % (optional)" inputMode="numeric" className={input} />
      </div>
      <div className="flex items-center gap-2">
        <label className="font-mono text-[10px] text-slate-500">concurrency</label>
        <input value={concurrency} onChange={(e) => setConcurrency(e.target.value)} inputMode="numeric" className="w-16 rounded-lg border border-white/10 bg-black/30 px-2 py-1 font-mono text-xs text-slate-200" />
        <button type="button" disabled={busy || !releaseId || !name.trim()} onClick={submit}
          className="rounded-full bg-lime/15 px-4 py-1.5 font-mono text-[11px] font-extrabold text-lime ring-1 ring-lime/30 hover:bg-lime/25 disabled:opacity-40">
          {busy ? "Creating…" : "Create (pending approval)"}
        </button>
        {note && <span className="font-mono text-[10px] text-lime">{note}</span>}
        {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
      </div>
      <p className="text-[10px] text-slate-500">
        Empty filters target the whole eligible fleet (active|testing|maintenance, compatible model/manufacturer).
        Canary keeps a deterministic prefix of the sorted pool. Incompatible devices are excluded with recorded reasons.
      </p>
    </div>
  );
}
