"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { fmt } from "@/lib/pricing";
import { REASON_LABEL } from "@/lib/helpdesk/refund-policy";
import type { RefundRequest } from "@/lib/helpdesk/types";
import { Pill } from "./SupportNav";

const TONE = { requested: "gold", approved: "cyan", issued: "lime", denied: "mist", failed: "red" } as const;

export async function helpdeskPost(body: object) {
  const res = await fetch("/api/admin/helpdesk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data } as { ok: boolean; data: Record<string, unknown> & { error?: string } };
}

/** Approve / deny / issue / record-manual controls for one refund request. The server re-checks every rule. */
export function RefundActions({ r, role, myId, ticketNumber }: { r: RefundRequest; role: "admin" | "staff"; myId: string; ticketNumber?: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [rid, setRid] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canDecide = !r.requiresAdmin || (role === "admin" && r.requestedBy !== myId);

  async function go(key: string, body: object) {
    setBusy(key); setMsg(null);
    const { ok, data } = await helpdeskPost(body);
    setBusy(null);
    setMsg({ ok: ok && data.status !== "deferred" && data.status !== "failed", text: (data.error as string) ?? (data.message as string) ?? "Done." });
    if (ok) router.refresh();
  }

  return (
    <div className="rounded-xl border border-mist bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><span className="font-display text-xl font-bold">{fmt(r.amountCents)}</span> <span className="text-graphite">· {REASON_LABEL[r.reason]}</span></div>
        <div className="flex gap-1.5">{r.requiresAdmin && <Pill tone="ink">Admin approval</Pill>}<Pill tone={TONE[r.status]}>{r.status}</Pill></div>
      </div>
      <p className="mt-1 text-xs text-graphite/80">Rental {r.rentalRef}{ticketNumber ? "" : ""} · requested {new Date(r.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}{r.decisionNote ? ` · note: ${r.decisionNote}` : ""}{r.providerRefundId ? ` · ${r.providerRefundId}` : ""}{r.error ? ` · error: ${r.error}` : ""}</p>

      {r.status === "requested" && (
        <div className="mt-3 space-y-2">
          {!canDecide && <p className="rounded-lg bg-gold/40 p-2 text-xs font-semibold">This amount needs a different admin to approve it.</p>}
          <input aria-label="Decision note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (required to deny)" maxLength={500} className="w-full rounded-lg border border-silver/70 px-3 py-2" />
          <div className="flex gap-2">
            <button disabled={!!busy || !canDecide} onClick={() => go("approve", { op: "refund_decide", id: r.id, decision: "approve", note })} className="min-h-10 rounded-full bg-ink px-4 font-bold text-white disabled:opacity-40">{busy === "approve" ? "…" : "Approve"}</button>
            <button disabled={!!busy || !canDecide} onClick={() => go("deny", { op: "refund_decide", id: r.id, decision: "deny", note })} className="min-h-10 rounded-full border border-ink/30 px-4 font-bold disabled:opacity-40">{busy === "deny" ? "…" : "Deny"}</button>
          </div>
        </div>
      )}
      {(r.status === "approved" || r.status === "failed") && (
        <div className="mt-3 space-y-2">
          <button disabled={!!busy} onClick={() => go("issue", { op: "refund_issue", id: r.id })} className="min-h-10 rounded-full bg-lime px-4 font-bold text-ink disabled:opacity-40">{busy === "issue" ? "Issuing…" : r.status === "failed" ? "Retry issuing" : "Issue refund"}</button>
          {role === "admin" && (
            <div className="flex gap-2">
              <input aria-label="Stripe refund id" value={rid} onChange={(e) => setRid(e.target.value)} placeholder="Refunded in Stripe? Paste re_… id" className="min-w-0 flex-1 rounded-lg border border-silver/70 px-3 py-2" />
              <button disabled={!!busy || !rid.trim()} onClick={() => go("record", { op: "refund_record", id: r.id, providerRefundId: rid.trim() })} className="min-h-10 rounded-full border border-ink/30 px-4 font-bold disabled:opacity-40">Record</button>
            </div>
          )}
        </div>
      )}
      {msg && <p role="status" className={`mt-2 rounded-lg p-2 text-xs font-semibold ${msg.ok ? "bg-lime/50" : "bg-gold/40"}`}>{msg.text}</p>}
    </div>
  );
}
