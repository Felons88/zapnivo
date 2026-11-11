"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { inputCls } from "@/components/forms";

/** Staff: adjust a group's shared credit pool (signed delta in cents) via the audited admin route. */
export function GroupCreditForm({ groupId, balance }: { groupId: string; balance: number }) {
  const router = useRouter();
  const [cents, setCents] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/admin/groups/${groupId}/credit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cents: Number(cents), note: note || undefined }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; group?: { credit_cents?: number } };
      if (!res.ok) { setMsg({ ok: false, text: j.error ?? "Adjustment failed." }); return; }
      const bal = j.group?.credit_cents ?? 0;
      setMsg({ ok: true, text: `New balance: $${(bal / 100).toFixed(2)}` });
      setCents(""); setNote(""); router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="mb-1 block text-[10px] font-extrabold uppercase text-graphite">± cents</label>
        <input required value={cents} onChange={(e) => setCents(e.target.value)} placeholder="2500" className={`${inputCls} w-28 !min-h-9 px-2 text-xs`} inputMode="numeric" />
      </div>
      <div className="min-w-40 flex-1">
        <label className="mb-1 block text-[10px] font-extrabold uppercase text-graphite">Note</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="why (audited)" className={`${inputCls} !min-h-9 px-2 text-xs`} />
      </div>
      <button disabled={busy} className="min-h-9 rounded-full bg-ink px-4 text-xs font-bold text-white">Apply</button>
      <span className="text-xs text-graphite">balance ${(balance / 100).toFixed(2)}</span>
      {msg && <span className={`w-full text-xs font-bold ${msg.ok ? "text-forest" : "text-red-700"}`}>{msg.text}</span>}
    </form>
  );
}
