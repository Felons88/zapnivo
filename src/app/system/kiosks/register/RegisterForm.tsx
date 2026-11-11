"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type VenueOption = { id: string; label: string };

const inputCls = "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-lime/50 focus:outline-none";
const labelCls = "mb-1 block text-[10px] font-extrabold uppercase tracking-wider text-slate-500";

export function RegisterForm({ venues }: { venues: VenueOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true); setError(null); setDone(null);
    const fd = new FormData(e.currentTarget);
    const num = (k: string) => { const v = String(fd.get(k) ?? "").trim(); return v === "" ? undefined : Number(v); };
    const str = (k: string) => { const v = String(fd.get(k) ?? "").trim(); return v === "" ? undefined : v; };
    try {
      const res = await fetch("/api/system/kiosks/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serial_number: str("serial_number"),
          manufacturer: str("manufacturer"),
          model: str("model"),
          gateway: str("gateway"),
          adapter_type: str("adapter_type"),
          slot_count: num("slot_count"),
          firmware_version: str("firmware_version"),
          venue_id: str("venue_id"),
          region: str("region"),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError((j as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      const id = (j as { device?: { id?: string } }).device?.id;
      setDone(id ?? "registered");
      router.refresh();
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-lime">Kiosk registered.</p>
        <p className="font-mono text-xs text-slate-400">device id: {done}</p>
        <div className="flex gap-2">
          <a href={`/system/kiosks/${done}`} className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8]">Open device</a>
          <button type="button" onClick={() => setDone(null)} className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Register another</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <div>
        <label className={labelCls} htmlFor="serial_number">Serial number *</label>
        <input id="serial_number" name="serial_number" required maxLength={120} className={`${inputCls} font-mono`} placeholder="ZN-2025-0001" />
      </div>
      <div>
        <label className={labelCls} htmlFor="slot_count">Slot count (1–64) *</label>
        <input id="slot_count" name="slot_count" type="number" min={1} max={64} required className={`${inputCls} font-mono`} placeholder="8" />
      </div>
      <div>
        <label className={labelCls} htmlFor="manufacturer">Manufacturer *</label>
        <input id="manufacturer" name="manufacturer" required maxLength={120} className={inputCls} placeholder="e.g. Zapnivo" />
      </div>
      <div>
        <label className={labelCls} htmlFor="model">Model *</label>
        <input id="model" name="model" required maxLength={120} className={inputCls} placeholder="e.g. ZK-1" />
      </div>
      <div>
        <label className={labelCls} htmlFor="gateway">Gateway / controller *</label>
        <input id="gateway" name="gateway" required maxLength={120} className={`${inputCls} font-mono`} placeholder="e.g. none / vendor-gw-01" />
      </div>
      <div>
        <label className={labelCls} htmlFor="adapter_type">Adapter type *</label>
        <input id="adapter_type" name="adapter_type" required maxLength={60} className={`${inputCls} font-mono`} placeholder="none" />
      </div>
      <div>
        <label className={labelCls} htmlFor="firmware_version">Firmware version</label>
        <input id="firmware_version" name="firmware_version" maxLength={60} className={`${inputCls} font-mono`} placeholder="optional" />
      </div>
      <div>
        <label className={labelCls} htmlFor="region">Region</label>
        <input id="region" name="region" maxLength={60} className={inputCls} placeholder="optional" />
      </div>
      <div className="sm:col-span-2">
        <label className={labelCls} htmlFor="venue_id">Venue</label>
        <select id="venue_id" name="venue_id" className={inputCls} defaultValue="">
          <option value="">— none —</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      </div>
      {error && <p className="sm:col-span-2 font-mono text-xs text-red-300">{error}</p>}
      <div className="sm:col-span-2">
        <button type="submit" disabled={busy}
          className="rounded-full bg-lime px-5 py-2.5 text-xs font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
          {busy ? "Registering…" : "Register kiosk"}
        </button>
      </div>
    </form>
  );
}
