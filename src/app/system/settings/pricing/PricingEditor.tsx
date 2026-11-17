"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const money = (c: number) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;

type Current = {
  id: string; approved: boolean; first_hour_cents: number; additional_hour_cents: number;
  first_24h_cap_cents: number; additional_day_cents: number | null;
  non_return_max_cents: number; non_return_after_hours: number;
  hold_cents: number | null;
};

function Field({ label, cents, onCents, hint }: { label: string; cents: string; onCents: (v: string) => void; hint?: string }) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <div className="mt-1 flex items-center gap-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1.5">
        <span className="font-mono text-xs text-slate-500">$</span>
        <input
          value={cents}
          onChange={(e) => onCents(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          className="w-full bg-transparent font-mono text-xs text-slate-200 outline-none"
        />
      </div>
      {hint && <span className="mt-0.5 block font-mono text-[9px] text-slate-600">{hint}</span>}
    </label>
  );
}

const toCents = (dollars: string) => {
  const n = Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Creates a new pricing_versions row (never edits in place). Fields are
 * prefilled from the live version; only changed values + approved are sent —
 * the API clones the rest from the latest row and audits the write.
 */
export function PricingEditor({ current, canManage }: { current: Current; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState((current.first_hour_cents / 100).toFixed(2));
  const [extra, setExtra] = useState((current.additional_hour_cents / 100).toFixed(2));
  const [hold, setHold] = useState(((current.hold_cents ?? current.non_return_max_cents) / 100).toFixed(2));
  const [nonReturn, setNonReturn] = useState((current.non_return_max_cents / 100).toFixed(2));
  const [deadline, setDeadline] = useState(String(current.non_return_after_hours));
  const [approved, setApproved] = useState(current.approved);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const body: Record<string, unknown> = { approved, note: note || undefined };
      const f = toCents(first), e = toCents(extra), hc = toCents(hold), nr = toCents(nonReturn);
      const h = Number.parseInt(deadline, 10);
      if (f === null || e === null || hc === null || nr === null || !Number.isInteger(h)) { setError("Enter valid dollar amounts and a whole-hour deadline."); setBusy(false); return; }
      if (f !== current.first_hour_cents) body.first_hour_cents = f;
      if (e !== current.additional_hour_cents) body.additional_hour_cents = e;
      if (hc !== (current.hold_cents ?? current.non_return_max_cents)) body.hold_cents = hc;
      if (nr !== current.non_return_max_cents) body.non_return_max_cents = nr;
      if (h !== current.non_return_after_hours) body.non_return_after_hours = h;
      const res = await fetch("/api/system/pricing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok) { setError(j.error ?? `HTTP ${res.status}`); return; }
      setDone(`Version ${j.id} is now the live pricing.`);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) return null;

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-mono text-sm font-bold text-slate-100">Live pricing — {current.id}</h2>
          <p className="mt-1 text-xs text-slate-400">
            {money(current.first_hour_cents)} first hour · {money(current.additional_hour_cents)}/extra hr · {money(current.hold_cents ?? current.non_return_max_cents)} hold/bank · {money(current.non_return_max_cents)} non-return (billed separately) · {current.non_return_after_hours}h deadline ·{" "}
            <span className={current.approved ? "text-lime" : "text-amber-300"}>{current.approved ? "approved" : "proposed (quotes 503 for customers)"}</span>
          </p>
        </div>
        <button type="button" onClick={() => setOpen(!open)} className="rounded-full bg-lime/15 px-4 py-1.5 font-mono text-[11px] font-bold text-lime ring-1 ring-lime/30 hover:bg-lime/25">
          {open ? "close" : "new version"}
        </button>
      </div>
      {done && <p className="mt-3 font-mono text-[11px] text-lime">{done}</p>}

      {open && (
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="First hour ($)" cents={first} onCents={setFirst} />
            <Field label="Each additional hour ($)" cents={extra} onCents={setExtra} hint="charged per started hour" />
            <Field label="Card hold per bank ($)" cents={hold} onCents={setHold} hint="authorization only; overage bills off-session" />
            <Field label="Non-return fee ($)" cents={nonReturn} onCents={setNonReturn} hint="billed separately if not returned" />
            <label className="block">
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">Return deadline (h)</span>
              <input value={deadline} onChange={(e) => setDeadline(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-xs text-slate-200 outline-none" />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="accent-lime" />
              Approved — customers can be quoted this pricing
            </label>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Audit note (optional)" className="min-w-56 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-xs text-slate-200 outline-none" />
            <button type="button" disabled={busy} onClick={save} className="rounded-full bg-lime/15 px-4 py-1.5 font-mono text-[11px] font-bold text-lime ring-1 ring-lime/30 hover:bg-lime/25 disabled:opacity-50">
              {busy ? "saving…" : "save as new version"}
            </button>
          </div>
          {error && <p className="mt-2 font-mono text-[10px] text-red-300">{error}</p>}
          <p className="mt-2 font-mono text-[10px] text-slate-600">Creates a new row — the previous version stays locked for rentals already in progress.</p>
        </div>
      )}
    </section>
  );
}
