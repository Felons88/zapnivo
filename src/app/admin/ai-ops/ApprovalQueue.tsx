"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApprovalRow } from "@/lib/agents/registry";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function ApprovalQueue({ approvals }: { approvals: ApprovalRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const decide = async (id: string, decision: "approved" | "rejected") => {
    const note = window.prompt(decision === "approved" ? "Approval note (optional):" : "Rejection reason (optional):") ?? "";
    setBusy(id); setErr("");
    const res = await fetch(`/api/admin/ai/approvals/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, note: note || undefined }),
    });
    if (!res.ok) setErr((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    setBusy(null);
    router.refresh();
  };

  return (
    <section aria-label="Approval queue" className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-bold">Approval queue</h2>
        <p className="mt-1 text-sm text-graphite">Agent-proposed actions that need a human decision. Consequential actions (refunds, payouts, hardware, admin grants) can never be approved here.</p>
      </div>
      {err && <p role="alert" className="rounded-xl bg-red-100 px-4 py-3 text-sm font-bold text-red-900">{err}</p>}
      {approvals.length === 0 ? (
        <div className="rounded-2xl border border-mist bg-white px-6 py-10 text-sm text-graphite shadow-sm">No pending approvals.</div>
      ) : (
        <ul className="space-y-3">
          {approvals.map((a) => (
            <li key={a.id} className="rounded-2xl border border-mist bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-display text-base font-bold">{a.action}</p>
                  <p className="text-xs text-graphite">{a.agent_id} · run {a.run_id ?? "—"} · {when(a.created_at)}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    className="min-h-9 rounded-full bg-lime px-4 text-xs font-bold disabled:opacity-50"
                    disabled={busy === a.id}
                    onClick={() => void decide(a.id, "approved")}
                  >{busy === a.id ? "…" : "Approve"}</button>
                  <button
                    className="min-h-9 rounded-full bg-mist px-4 text-xs font-bold hover:bg-red-100 disabled:opacity-50"
                    disabled={busy === a.id}
                    onClick={() => void decide(a.id, "rejected")}
                  >Reject</button>
                </div>
              </div>
              <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-mist/50 p-3 text-[11px] text-graphite">{JSON.stringify(a.payload, null, 2)}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
