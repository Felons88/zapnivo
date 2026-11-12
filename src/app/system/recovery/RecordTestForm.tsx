"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Form to record a manually-performed recovery test (audited server-side). */
export function RecordTestForm({ canRecord, methods }: { canRecord: boolean; methods: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ testedAt: "", environment: "production", method: "supabase_backup_restore", result: "passed", rpoMinutes: "", rtoMinutes: "", notes: "" });

  if (!canRecord) {
    return <p className="text-xs text-slate-500">Recording a recovery test requires system.changes.request.</p>;
  }

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/system/recovery/tests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          testedAt: form.testedAt || undefined,
          environment: form.environment,
          method: form.method,
          result: form.result,
          rpoMinutes: form.rpoMinutes ? parseInt(form.rpoMinutes, 10) : null,
          rtoMinutes: form.rtoMinutes ? parseInt(form.rtoMinutes, 10) : null,
          notes: form.notes || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError((j as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      setOpen(false);
      setForm({ testedAt: "", environment: "production", method: "supabase_backup_restore", result: "passed", rpoMinutes: "", rtoMinutes: "", notes: "" });
      router.refresh();
    } finally { setBusy(false); }
  };

  const input = "w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-lime/40 focus:outline-none";

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="eyebrow text-slate-400">Record a recovery test</h2>
          <p className="mt-1 text-xs text-slate-500">
            Records a claim that a human performed a restore test — it does not run or verify a restore.
            Measured RPO/RTO minutes feed the unverified targets above.
          </p>
        </div>
        <button
          type="button" onClick={() => setOpen((v) => !v)}
          className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8]"
        >
          {open ? "Close" : "Record test"}
        </button>
      </div>

      {open && (
        <div className="mt-4 grid gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 sm:grid-cols-2">
          <label className="text-[11px] text-slate-500">Tested at (UTC, blank = now)
            <input className={input} type="datetime-local" value={form.testedAt} onChange={(e) => setForm({ ...form, testedAt: e.target.value })} />
          </label>
          <label className="text-[11px] text-slate-500">Environment
            <input className={input} value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} />
          </label>
          <label className="text-[11px] text-slate-500">Method
            <select className={input} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {methods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-slate-500">Result
            <select className={input} value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })}>
              <option value="passed">passed</option>
              <option value="partial">partial</option>
              <option value="failed">failed</option>
            </select>
          </label>
          <label className="text-[11px] text-slate-500">Measured RPO (minutes)
            <input className={input} type="number" min={0} value={form.rpoMinutes} onChange={(e) => setForm({ ...form, rpoMinutes: e.target.value })} placeholder="unverified" />
          </label>
          <label className="text-[11px] text-slate-500">Measured RTO (minutes)
            <input className={input} type="number" min={0} value={form.rtoMinutes} onChange={(e) => setForm({ ...form, rtoMinutes: e.target.value })} placeholder="unverified" />
          </label>
          <label className="text-[11px] text-slate-500 sm:col-span-2">Notes
            <textarea className={input} rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Restore point chosen, verification steps, gaps found…" />
          </label>
          {error && <p className="font-mono text-xs text-red-300 sm:col-span-2">{error}</p>}
          <div className="sm:col-span-2">
            <button type="button" disabled={busy} onClick={submit} className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50">
              {busy ? "Recording…" : "Record test"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
