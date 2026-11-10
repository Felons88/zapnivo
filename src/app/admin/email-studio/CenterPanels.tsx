"use client";

import { useEffect, useMemo, useState } from "react";
import { EMAIL_SENDERS } from "@/lib/email/senders";
import {
  normalizeTriggerStatus,
  triggerStatusLabel,
  type StudioLogRow,
  type StudioSenderRow,
  type StudioTriggerRow,
} from "@/lib/email-studio";

/* ── shared bits ────────────────────────────────────────────────────────── */

const card = "rounded-2xl border border-mist bg-white p-6 shadow-sm";
const th = "px-3 py-2 text-left text-[11px] font-extrabold uppercase tracking-wide text-silver";
const td = "px-3 py-2.5 text-sm align-top";

const senderName = (id: string | null | undefined) =>
  id && id in EMAIL_SENDERS ? EMAIL_SENDERS[id as keyof typeof EMAIL_SENDERS].name : id || "—";

const STATUS_TONE: Record<string, string> = {
  queued: "bg-gold/50 text-ink",
  sent: "bg-lime/60 text-ink",
  failed: "bg-red-50 text-red-700",
};

const TRIGGER_TONE: Record<string, string> = {
  live: "bg-lime/60 text-ink",
  planned: "bg-mist text-graphite",
  no_template: "bg-gold/50 text-ink",
};

function Pill({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${tone ?? "bg-mist text-graphite"}`}>{children}</span>;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type FetchState<T> = { loading: boolean; data: T | null; note: string | null };

async function getJson<T>(url: string): Promise<FetchState<T>> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const data = (await res.json()) as T & { available?: boolean; note?: string; error?: string };
    if (!res.ok) return { loading: false, data: null, note: data.error ?? `Request failed (HTTP ${res.status}).` };
    return { loading: false, data, note: data.available === false ? data.note ?? "Not available in this environment." : null };
  } catch {
    return { loading: false, data: null, note: "Couldn't reach the admin API." };
  }
}

/* ── Senders ────────────────────────────────────────────────────────────── */

export function SendersPanel() {
  const [state, setState] = useState<FetchState<{ senders: StudioSenderRow[] }>>({ loading: true, data: null, note: null });
  useEffect(() => { void getJson<{ senders: StudioSenderRow[] }>("/api/admin/email-studio/senders").then(setState); }, []);

  if (state.loading) return <p className="text-sm text-graphite">Loading senders…</p>;
  if (!state.data) return <p className="rounded-xl bg-mist/60 px-4 py-3 text-sm font-bold text-graphite">{state.note ?? "Sender registry unavailable."}</p>;

  return (
    <section className={card}>
      <h2 className="font-display text-xl font-bold">Sender identities</h2>
      <p className="mt-1 text-sm text-graphite">
        Every outbound email resolves its From/Reply-To through this registry. These are configured sending
        addresses only — inbound mail to them is <strong>not verified</strong>.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr className="border-b border-mist">
              <th className={th}>Sender</th>
              <th className={th}>From</th>
              <th className={th}>Reply-To</th>
              <th className={th}>Used by</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {state.data.senders.map((s) => (
              <tr key={s.id} className="border-b border-mist/60 last:border-0">
                <td className={td}>
                  <span className="font-bold text-ink">{s.name}</span>
                  <code className="ml-2 rounded bg-mist px-1.5 py-0.5 text-[11px]">{s.id}</code>
                </td>
                <td className={`${td} font-semibold`}>{s.email}</td>
                <td className={`${td} text-graphite`}>{s.replyTo}</td>
                <td className={td}>
                  {s.triggers.length === 0 ? (
                    <span className="text-xs text-silver">No triggers yet</span>
                  ) : (
                    <details>
                      <summary className="cursor-pointer text-xs font-bold text-ink">{s.triggers.length} trigger{s.triggers.length === 1 ? "" : "s"}</summary>
                      <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
                        {s.triggers.map((ev) => <li key={ev}><code className="text-[11px] text-graphite">{ev}</code></li>)}
                      </ul>
                    </details>
                  )}
                </td>
                <td className={td}>
                  <Pill tone="bg-mist text-graphite">Configured sender</Pill>
                  <span className="mt-1 block text-[11px] font-semibold text-silver">Inbound: not verified</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── Triggers ───────────────────────────────────────────────────────────── */

export function TriggersPanel() {
  const [state, setState] = useState<FetchState<{ triggers: StudioTriggerRow[] }>>({ loading: true, data: null, note: null });
  const [senderFilter, setSenderFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  useEffect(() => { void getJson<{ triggers: StudioTriggerRow[] }>("/api/admin/email-studio/triggers").then(setState); }, []);

  const rows = useMemo(() => {
    const all = state.data?.triggers ?? [];
    return all.filter((t) =>
      (!senderFilter || t.sender === senderFilter) &&
      (!statusFilter || normalizeTriggerStatus(t.status) === statusFilter));
  }, [state.data, senderFilter, statusFilter]);

  const senders = useMemo(() => Array.from(new Set((state.data?.triggers ?? []).map((t) => t.sender).filter(Boolean))).sort(), [state.data]);
  const statuses = useMemo(() => Array.from(new Set((state.data?.triggers ?? []).map((t) => normalizeTriggerStatus(t.status)))).sort(), [state.data]);

  if (state.loading) return <p className="text-sm text-graphite">Loading triggers…</p>;
  if (!state.data) return <p className="rounded-xl bg-mist/60 px-4 py-3 text-sm font-bold text-graphite">{state.note ?? "Trigger registry unavailable."}</p>;

  return (
    <section className={card}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-bold">Email triggers</h2>
          <p className="mt-1 max-w-2xl text-sm text-graphite">
            Business events mapped to a sender, template and recipient. Informational only — triggers are
            defined in code and can't be toggled here yet.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select value={senderFilter} onChange={(e) => setSenderFilter(e.target.value)} className="min-h-9 rounded-lg border border-silver/70 px-3 text-xs font-bold" aria-label="Filter by sender">
            <option value="">All senders</option>
            {senders.map((s) => <option key={s} value={s}>{senderName(s)} ({s})</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="min-h-9 rounded-lg border border-silver/70 px-3 text-xs font-bold" aria-label="Filter by status">
            <option value="">All statuses</option>
            {statuses.map((s) => <option key={s} value={s}>{triggerStatusLabel(s)}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="border-b border-mist">
              <th className={th}>Event</th>
              <th className={th}>Sender</th>
              <th className={th}>Template</th>
              <th className={th}>Recipients</th>
              <th className={th}>Status</th>
              <th className={th}>Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const norm = normalizeTriggerStatus(t.status);
              return (
                <tr key={t.event} className="border-b border-mist/60 last:border-0">
                  <td className={`${td} font-bold`}><code className="text-xs">{t.event}</code></td>
                  <td className={td}>
                    <span className="font-semibold">{senderName(t.sender)}</span>
                    <code className="ml-1 text-[11px] text-silver">{t.sender}</code>
                  </td>
                  <td className={td}>{t.template ? <code className="rounded bg-mist px-1.5 py-0.5 text-[11px]">{t.template}</code> : <span className="text-xs text-silver">—</span>}</td>
                  <td className={`${td} text-graphite`}>{t.recipientKind}</td>
                  <td className={td}><Pill tone={TRIGGER_TONE[norm]}>{triggerStatusLabel(t.status)}</Pill></td>
                  <td className={`${td} max-w-[280px] text-xs text-graphite`}>{t.description}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td className={`${td} text-graphite`} colSpan={6}>No triggers match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── Outbox log ─────────────────────────────────────────────────────────── */

export function LogPanel() {
  const [state, setState] = useState<FetchState<{ emails: StudioLogRow[] }>>({ loading: true, data: null, note: null });
  useEffect(() => { void getJson<{ emails: StudioLogRow[] }>("/api/admin/email-studio/log").then(setState); }, []);

  if (state.loading) return <p className="text-sm text-graphite">Loading outbox…</p>;
  if (!state.data) return <p className="rounded-xl bg-mist/60 px-4 py-3 text-sm font-bold text-graphite">{state.note ?? "Outbox unavailable."}</p>;
  if (state.data.emails.length === 0) {
    return (
      <section className={card}>
        <h2 className="font-display text-xl font-bold">Email outbox</h2>
        <p className="mt-3 text-sm text-graphite">No queued, sent or failed emails yet — the outbox is empty.</p>
      </section>
    );
  }

  return (
    <section className={card}>
      <h2 className="font-display text-xl font-bold">Email outbox</h2>
      <p className="mt-1 text-sm text-graphite">Recent queued/sent/failed emails, newest first (latest 100).</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="border-b border-mist">
              <th className={th}>To</th>
              <th className={th}>Subject</th>
              <th className={th}>Sender</th>
              <th className={th}>Event</th>
              <th className={th}>Status</th>
              <th className={th}>Queued</th>
              <th className={th}>Error</th>
            </tr>
          </thead>
          <tbody>
            {state.data.emails.map((e) => (
              <tr key={e.id} className="border-b border-mist/60 last:border-0">
                <td className={`${td} font-semibold`}>{e.to}</td>
                <td className={`${td} max-w-[260px] truncate`} title={e.subject}>{e.subject}</td>
                <td className={td}>
                  {e.senderName ?? <span className="text-silver">default</span>}
                  {e.replyTo && <span className="block text-[11px] text-silver">reply-to {e.replyTo}</span>}
                </td>
                <td className={td}>{e.event ? <code className="text-[11px]">{e.event}</code> : <span className="text-xs text-silver">—</span>}</td>
                <td className={td}><Pill tone={STATUS_TONE[e.status]}>{e.status}</Pill></td>
                <td className={`${td} whitespace-nowrap text-xs text-graphite`}>{fmtDate(e.createdAt)}</td>
                <td className={`${td} max-w-[200px] truncate text-xs text-red-700`} title={e.error ?? ""}>{e.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
