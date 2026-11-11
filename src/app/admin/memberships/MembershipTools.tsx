"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const input = "min-h-9 rounded-lg border border-silver/70 px-3 text-sm";

/** Activate/deactivate toggle for a membership plan or prepaid package. */
export function ActiveToggle({ kind, id, active }: { kind: "plans" | "packages"; id: string; active: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const toggle = async () => {
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/admin/monetization/${kind}/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !active }),
      });
      if (!res.ok) { setErr("Save failed"); setBusy(false); return; }
      router.refresh();
    } catch { setErr("Save failed"); setBusy(false); }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={toggle} disabled={busy}
        className={`min-h-8 rounded-full px-3 text-xs font-bold disabled:opacity-50 ${active ? "bg-lime text-ink" : "border border-silver/60 text-graphite"}`}>
        {busy ? "…" : active ? "Active — deactivate" : "Inactive — activate"}
      </button>
      {err && <span className="text-xs font-semibold text-[#8a4b00]">{err}</span>}
    </span>
  );
}

/** Inline editor for a prepaid package: price (dollars), units, validity days. */
export function PackageEditor({ id, priceCents, units, validityDays }: {
  id: string; priceCents: number; units: number; validityDays: number | null;
}) {
  const router = useRouter();
  const [price, setPrice] = useState((priceCents / 100).toString());
  const [u, setU] = useState(String(units));
  const [days, setDays] = useState(validityDays === null ? "" : String(validityDays));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const save = async () => {
    const priceCentsNum = Math.round(Number(price) * 100);
    const unitsNum = Number(u);
    const daysNum = days.trim() === "" ? null : Number(days);
    if (!Number.isFinite(priceCentsNum) || priceCentsNum < 1 || !Number.isInteger(unitsNum) || unitsNum < 1 || (daysNum !== null && (!Number.isInteger(daysNum) || daysNum < 1))) {
      setMsg("Check price, units and validity."); return;
    }
    setBusy(true); setMsg("");
    try {
      const res = await fetch(`/api/admin/monetization/packages/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ price_cents: priceCentsNum, units: unitsNum, validity_days: daysNum }),
      });
      if (!res.ok) { setMsg("Save failed"); setBusy(false); return; }
      setMsg("Saved");
      router.refresh();
      setBusy(false);
    } catch { setMsg("Save failed"); setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs font-bold text-graphite">Price $
        <input className={`${input} ml-1 w-24`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Price in dollars" />
      </label>
      <label className="text-xs font-bold text-graphite">Units
        <input className={`${input} ml-1 w-20`} inputMode="numeric" value={u} onChange={(e) => setU(e.target.value)} aria-label="Units" />
      </label>
      <label className="text-xs font-bold text-graphite">Valid days
        <input className={`${input} ml-1 w-20`} inputMode="numeric" placeholder="never" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Validity days, blank for never" />
      </label>
      <button type="button" onClick={save} disabled={busy} className="min-h-9 rounded-full bg-ink px-4 text-xs font-bold text-white disabled:opacity-50">{busy ? "…" : "Save"}</button>
      {msg && <span className="text-xs font-semibold text-forest">{msg}</span>}
    </div>
  );
}
