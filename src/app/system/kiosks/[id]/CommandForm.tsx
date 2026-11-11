"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const ALLOWED = ["status_request", "inventory_request", "firmware_version_request"] as const;

/**
 * Records a read-only command request. Every command lands state='failed' with
 * reason='adapter_disabled' while KIOSK_ADAPTER=none — the UI states this plainly.
 */
export function CommandForm({ deviceId, canManage }: { deviceId: string; canManage: boolean }) {
  const router = useRouter();
  const [type, setType] = useState<string>(ALLOWED[0]);
  const [idem, setIdem] = useState<string>(() => `cmd-${crypto.randomUUID()}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!canManage) return <p className="text-xs text-slate-500">Requires system.kiosks.manage to record commands.</p>;

  const submit = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const res = await fetch(`/api/system/kiosks/${deviceId}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command_type: type, idempotency_key: idem }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError((j as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      const c = (j as { command?: { state?: string; result?: { reason?: string } } }).command;
      setNote(`recorded — state=${c?.state ?? "?"} (${c?.result?.reason ?? "no reason"})`);
      setIdem(`cmd-${crypto.randomUUID()}`); // fresh key for the next distinct command
      router.refresh();
    } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={type} onChange={(e) => setType(e.target.value)}
        className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200 focus:border-lime/50 focus:outline-none">
        {ALLOWED.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <code className="max-w-[220px] truncate rounded-lg bg-black/30 px-2 py-1.5 font-mono text-[10px] text-slate-400" title={idem}>{idem}</code>
      <button type="button" disabled={busy} onClick={submit}
        className="rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] font-extrabold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50">
        {busy ? "Recording…" : "Record command"}
      </button>
      {note && <span className="font-mono text-[10px] text-slate-300">{note}</span>}
      {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
      <span className="w-full text-[10px] text-slate-500">
        Adapter: none — commands are recorded as failed/adapter_disabled, never dispatched.
      </span>
    </div>
  );
}
