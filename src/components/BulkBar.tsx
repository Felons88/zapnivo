"use client";

import { useEffect, useState } from "react";

const SEL = 'input[type="checkbox"][name="numbers"][form="bulk-form"]';
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>(SEL));

/**
 * Sticky bulk-action bar for the support inbox. Row checkboxes are rendered by the server page with
 * name="numbers" form="bulk-form"; this component owns the form, select-all and the selected count.
 * Refund approval is deliberately not offered here.
 */
export function BulkBar({ staff, returnQuery }: { staff: { id: string; label: string }[]; returnQuery: string }) {
  const [count, setCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState("");

  useEffect(() => {
    const sync = () => { const b = boxes(); setTotal(b.length); setCount(b.filter((x) => x.checked).length); };
    sync();
    document.addEventListener("change", sync);
    return () => document.removeEventListener("change", sync);
  }, []);

  const toggleAll = (on: boolean) => { boxes().forEach((b) => { b.checked = on; }); setCount(on ? boxes().length : 0); };

  return (
    <form id="bulk-form" method="POST" action="/api/admin/tickets/bulk"
      onSubmit={(e) => {
        const label = (e.currentTarget.elements.namedItem("action") as HTMLSelectElement | null)?.selectedOptions[0]?.text ?? "";
        if (count === 0 || !action || !window.confirm(`${label} for ${count} ticket${count === 1 ? "" : "s"}?`)) e.preventDefault();
      }}
      className="sticky bottom-3 z-20 mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-mist bg-white px-4 py-3 shadow-lg">
      <input type="hidden" name="returnQuery" value={returnQuery} />
      <label className="flex items-center gap-2 text-sm font-bold">
        <input type="checkbox" checked={total > 0 && count === total} onChange={(e) => toggleAll(e.target.checked)} aria-label="Select all tickets shown" />
        Select all
      </label>
      <span className="text-sm text-graphite" aria-live="polite">{count} selected{total > 100 ? " (max 100 per action)" : ""}</span>
      <select name="action" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Bulk action" className="min-h-10 rounded-full border border-silver/70 px-3 text-sm">
        <option value="">Choose action…</option>
        <option value="assign_me">Assign to me</option>
        {staff.length > 0 && <option value="assign_staff">Assign to staff member…</option>}
        <option value="unassign">Unassign</option>
        <option value="resolve">Mark resolved</option>
        <option value="close">Close</option>
        <option value="priority">Set priority…</option>
      </select>
      {action === "assign_staff" && (
        <select name="assignee" required aria-label="Staff member" className="min-h-10 rounded-full border border-silver/70 px-3 text-sm">
          <option value="">Select person…</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      )}
      {action === "priority" && (
        <select name="priority" required aria-label="Priority" className="min-h-10 rounded-full border border-silver/70 px-3 text-sm">
          {["urgent", "high", "normal", "low"].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      )}
      <button type="submit" disabled={count === 0 || !action} className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white disabled:opacity-40">Apply</button>
    </form>
  );
}
