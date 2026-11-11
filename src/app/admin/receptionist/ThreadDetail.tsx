"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pill } from "@/components/SupportNav";
import { STAFF_TRANSITIONS } from "@/lib/receptionist/types";
import type { AuditRow, MessageRow, ReceptionistStatus, ThreadRow } from "@/lib/receptionist/types";

type Props = {
  thread: ThreadRow;
  messages: MessageRow[];
  audit: AuditRow[];
  draft: MessageRow | null;
  staff: { id: string; label: string }[];
  currentUserId: string | null;
};

const KIND_TONE: Record<string, "mist" | "lime" | "gold" | "red" | "ink" | "cyan"> = {
  inbound: "mist", outbound: "lime", draft: "gold", internal: "cyan",
};

async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return res.ok;
}

export function ThreadDetail({ thread, messages, audit, draft, staff, currentUserId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [draftBody, setDraftBody] = useState(draft?.body_text ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  const act = (fn: () => Promise<boolean>, okText: string) =>
    startTransition(async () => {
      const ok = await fn();
      setMsg(ok ? okText : "Action failed — check permissions/backend.");
      router.refresh();
    });

  const base = `/api/admin/receptionist/threads/${thread.id}`;
  const transitions = STAFF_TRANSITIONS[thread.status];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-2xl border border-mist bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-bold">{thread.sender_email}</p>
            <p className="text-sm text-graphite">{thread.subject}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Pill tone="mist">{thread.category.replace(/_/g, " ")}</Pill>
            <Pill tone={thread.priority === "urgent" ? "red" : thread.priority === "high" ? "gold" : "mist"}>{thread.priority}</Pill>
            <Pill tone="ink">{thread.status.replace(/_/g, " ")}</Pill>
            {thread.ai_confidence != null && <Pill tone="cyan">AI {Math.round(thread.ai_confidence * 100)}%</Pill>}
          </div>
        </div>
        {thread.escalation_reason && (
          <p className="mt-2 rounded-lg bg-gold/20 px-3 py-2 text-xs font-semibold">Escalation: {thread.escalation_reason}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-graphite">Autonomy {thread.autonomy_level} · opened {new Date(thread.created_at).toLocaleString()}</span>
          <select
            aria-label="Assign thread"
            className="ml-auto rounded-full border border-silver/70 bg-white px-3 py-1.5 text-xs font-bold"
            value=""
            disabled={pending}
            onChange={(e) => {
              const v = e.target.value;
              if (v) act(() => post(`${base}/assign`, { staffId: v }), "Assigned.");
            }}
          >
            <option value="">Assign to…</option>
            {staff.filter((s) => s.id !== currentUserId).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        {transitions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {transitions.map((t) => (
              <button key={t} disabled={pending}
                onClick={() => act(() => post(`${base}/status`, { status: t }), `Moved to ${t}.`)}
                className="rounded-full border border-silver/70 px-3 py-1 text-[11px] font-bold hover:bg-mist">
                → {t.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Pending AI draft */}
      {draft && (
        <div className="rounded-2xl border border-gold/60 bg-gold/10 p-4">
          <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-graphite">AI draft — review before sending</p>
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            rows={8}
            className="w-full rounded-xl border border-silver/70 bg-white p-3 text-sm"
            aria-label="Draft reply"
          />
          <button
            disabled={pending || !draftBody.trim()}
            onClick={() => act(() => post(`${base}/approve-draft`, { body: draftBody }), "Draft sent.")}
            className="mt-2 rounded-full bg-ink px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            {pending ? "Sending…" : "Approve & send"}
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="space-y-3">
        {messages.map((m) => (
          <div key={m.id} className={`rounded-2xl border p-4 ${m.direction === "internal" ? "border-cyan/40 bg-cyan/10" : "border-mist bg-white"}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <Pill tone={KIND_TONE[m.direction] ?? "mist"}>{m.direction}</Pill>
              <span className="font-bold">{m.sender_kind}</span>
              <span className="text-graphite">{m.from_addr ?? "—"} → {m.to_addr ?? "—"}</span>
              <span className="ml-auto text-graphite">{new Date(m.created_at).toLocaleString()}</span>
            </div>
            {m.subject && <p className="mb-1 text-xs font-bold text-graphite">{m.subject}</p>}
            <p className="whitespace-pre-wrap text-sm">{m.body_text}</p>
          </div>
        ))}
      </div>

      {/* Reply + note */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-mist bg-white p-4">
          <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-graphite">Reply as hello@zapnivo.com</p>
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={5}
            placeholder="Write a reply…" className="w-full rounded-xl border border-silver/70 p-3 text-sm" aria-label="Reply" />
          <button disabled={pending || !reply.trim()}
            onClick={() => act(async () => { const ok = await post(`${base}/reply`, { body: reply }); if (ok) setReply(""); return ok; }, "Reply sent.")}
            className="mt-2 rounded-full bg-ink px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            Send reply
          </button>
        </div>
        <div className="rounded-2xl border border-cyan/40 bg-cyan/10 p-4">
          <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-graphite">Internal note (staff only)</p>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5}
            placeholder="Note for the team…" className="w-full rounded-xl border border-silver/70 bg-white p-3 text-sm" aria-label="Internal note" />
          <button disabled={pending || !note.trim()}
            onClick={() => act(async () => { const ok = await post(`${base}/note`, { body: note }); if (ok) setNote(""); return ok; }, "Note added.")}
            className="mt-2 rounded-full border border-ink px-4 py-2 text-sm font-bold hover:bg-mist disabled:opacity-50">
            Add note
          </button>
        </div>
      </div>

      {msg && <p role="status" className="rounded-xl bg-lime/30 px-4 py-2 text-sm font-semibold">{msg}</p>}

      {/* Audit */}
      <details className="rounded-2xl border border-mist bg-white p-4">
        <summary className="cursor-pointer text-xs font-extrabold uppercase tracking-wider text-graphite">Audit history ({audit.length})</summary>
        <ul className="mt-3 space-y-2">
          {audit.map((a) => (
            <li key={a.id} className="text-xs">
              <span className="font-bold">{a.action}</span>
              <span className="text-graphite"> · {a.actor} · {new Date(a.created_at).toLocaleString()}</span>
              {Object.keys(a.detail ?? {}).length > 0 && (
                <code className="ml-2 rounded bg-mist px-1.5 py-0.5 text-[10px]">{JSON.stringify(a.detail).slice(0, 200)}</code>
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
