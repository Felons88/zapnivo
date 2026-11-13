"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MAINTENANCE_VISIT_TYPES } from "@/lib/system/device-config.shared";

/** Schedule-visit form → POST /api/system/kiosks/maintenance. */
export function VisitForm({ devices }: { devices: { id: string; label: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const fd = new FormData(e.currentTarget);
    const scheduled = String(fd.get("scheduled_at") ?? "").trim();
    try {
      const res = await fetch("/api/system/kiosks/maintenance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_id: fd.get("device_id"),
          visit_type: fd.get("visit_type"),
          scheduled_at: scheduled ? new Date(scheduled).toISOString() : undefined,
          technician: String(fd.get("technician") ?? "").trim() || undefined,
          notes: String(fd.get("notes") ?? "").trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      else { (e.target as HTMLFormElement).reset(); router.refresh(); }
    } finally { setBusy(false); }
  };

  const input = "mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200";
  const label = "block text-[10px] font-extrabold uppercase tracking-wider text-slate-500";

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className={label}>Device
        <select name="device_id" required defaultValue="" className={input}>
          <option value="" disabled>Select device…</option>
          {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      </label>
      <label className={label}>Type
        <select name="visit_type" defaultValue="routine" className={input}>
          {MAINTENANCE_VISIT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <label className={label}>Scheduled at (UTC)
        <input name="scheduled_at" type="datetime-local" className={input} />
      </label>
      <label className={label}>Technician
        <input name="technician" type="text" maxLength={120} placeholder="name / vendor" className={input} />
      </label>
      <label className={label}>Notes
        <textarea name="notes" rows={3} maxLength={2000} className={input} />
      </label>
      {error && <p className="font-mono text-[11px] text-red-300">{error}</p>}
      <button type="submit" disabled={busy || devices.length === 0}
        className="w-full rounded-full bg-lime px-4 py-2 text-xs font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
        {busy ? "…" : "Schedule visit"}
      </button>
      {devices.length === 0 && <p className="text-[10px] text-slate-500">No non-decommissioned devices in the registry.</p>}
    </form>
  );
}
