export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser } from "@/lib/auth";
import { BulkBar } from "@/components/BulkBar";
import { isUuid, sanitizeInboxQuery } from "@/lib/helpdesk/inbox-query";
import { serviceClient } from "@/lib/supabase";
import { defaultCtx } from "@/lib/helpdesk/service";
import { humanDue, slaStatus } from "@/lib/helpdesk/sla";
import { QUEUES, type Queue, type Ticket, type TicketFilter } from "@/lib/helpdesk/types";

export const metadata: Metadata = { title: "Support inbox", robots: { index: false, follow: false } };

const VIEWS = [
  { id: "person", label: "Needs a person" }, { id: "mine", label: "Mine" }, { id: "unassigned", label: "Unassigned" },
  { id: "urgent", label: "Urgent" }, { id: "ai", label: "AI handling" }, { id: "open", label: "All open" }, { id: "done", label: "Resolved" },
] as const;

const PRIO_TONE = { urgent: "red", high: "gold", normal: "mist", low: "mist" } as const;
const SLA_TONE = { breached: "red", due_soon: "gold", ok: "mist", met: "lime", "n/a": "mist" } as const;

export default async function Inbox({ searchParams }: { searchParams: Promise<{ view?: string; queue?: string; q?: string; result?: string; detail?: string }> }) {
  const sp = await searchParams;
  const view = VIEWS.some((v) => v.id === sp.view) ? sp.view! : sp.queue ? "open" : "person";
  const queue = (QUEUES as readonly string[]).includes(sp.queue ?? "") ? (sp.queue as Queue) : undefined;
  const user = await getSessionUser();
  const ctx = await defaultCtx();

  let tickets: Ticket[] = [];
  if (ctx) {
    const base: TicketFilter = { queue, q: sp.q, limit: 300 };
    const open: TicketFilter["states"] = ["open", "pending_customer", "pending_internal"];
    const f: TicketFilter = view === "done" ? { ...base, states: ["resolved", "closed"] }
      : view === "mine" ? { ...base, states: open, assignedTo: user?.id }
      : view === "unassigned" ? { ...base, states: open, assignedTo: "unassigned" }
      : view === "urgent" ? { ...base, states: open, priority: "urgent" }
      : view === "ai" ? { ...base, states: open, aiState: "ai_active" }
      : view === "person" ? { ...base, states: open }
      : { ...base, states: open };
    tickets = await ctx.repo.listTickets(f);
    if (view === "person") tickets = tickets.filter((t) => t.aiState !== "ai_active" && t.state !== "pending_customer");
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    if (view !== "done") tickets.sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt));
  }
  const now = new Date();

  // Saved views (own profile only) and staff list for bulk assignment.
  const canSaveViews = !!user && isUuid(user.id);
  let savedViews: { id: string; name: string; query: string }[] = [];
  let staffList: { id: string; label: string }[] = [];
  const db = canSaveViews ? serviceClient() : null;
  if (db && user) {
    const [sv, st] = await Promise.all([
      db.from("saved_views").select("id,name,query").eq("profile_id", user.id).order("created_at", { ascending: true }).limit(20),
      db.from("profiles").select("id,email,full_name").in("role", ["admin", "staff"]).limit(200),
    ]);
    savedViews = (sv.data ?? []).map((r) => ({ id: String(r.id), name: String(r.name), query: sanitizeInboxQuery(String(r.query)) }));
    staffList = (st.data ?? []).filter((s) => s.id !== user.id).map((s) => ({ id: String(s.id), label: String(s.full_name || s.email) }));
  }
  const currentQuery = sanitizeInboxQuery(new URLSearchParams({ view, ...(queue ? { queue } : {}), ...(sp.q ? { q: sp.q } : {}) }).toString());
  const result = sp.result === "ok" || sp.result === "partial" || sp.result === "error" ? sp.result : null;
  const q = (extra: Record<string, string>) => { const p = new URLSearchParams({ ...(queue ? { queue } : {}), ...extra }); return `/admin/support?${p}`; };

  const nav = queue === "partner" ? "partner" : queue === "safety" ? "safety" : "inbox";
  return (
    <AdminGate title={nav === "partner" ? "Partner relations" : nav === "safety" ? "Safety queue" : "Support inbox"} nav={nav}>
      {!ctx ? (
        <EmptyCard title="Support system not connected">Connect Supabase (and apply migrations 0001–0004), or for local development set <code>HELPDESK_DEV_STORE=1</code> and restart <code>npm run dev</code>.</EmptyCard>
      ) : (
        <>
          {result && (
            <p role="status" className={`mb-4 rounded-xl px-4 py-3 text-sm font-semibold ${result === "ok" ? "bg-lime/30" : result === "partial" ? "bg-gold/20" : "bg-red-100 text-red-900"}`}>{(sp.detail ?? "").slice(0, 300)}</p>
          )}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {savedViews.map((v) => (
              <span key={v.id} className="inline-flex items-center overflow-hidden rounded-full border border-silver/70 bg-white text-sm">
                <Link href={`/admin/support?${v.query}`} className="px-3 py-1.5 font-bold hover:bg-mist">{v.name}</Link>
                <form method="POST" action="/api/admin/views"><input type="hidden" name="action" value="delete" /><input type="hidden" name="id" value={v.id} /><input type="hidden" name="returnQuery" value={currentQuery} />
                  <button type="submit" aria-label={`Delete saved view ${v.name}`} className="px-2 py-1.5 text-graphite hover:bg-mist">×</button></form>
              </span>
            ))}
            {canSaveViews ? (
              <form method="POST" action="/api/admin/views" className="flex gap-2">
                <input type="hidden" name="action" value="save" /><input type="hidden" name="query" value={currentQuery} /><input type="hidden" name="returnQuery" value={currentQuery} />
                <input name="name" required maxLength={60} aria-label="Saved view name" placeholder="Name this view…" className="min-h-9 rounded-full border border-silver/70 px-3 text-sm" />
                <button type="submit" className="min-h-9 rounded-full bg-white px-3 text-sm font-bold ring-1 ring-silver/70 hover:bg-mist">Save this view</button>
              </form>
            ) : (
              <span className="text-xs text-graphite">Saved views need a real staff account; this development session can&apos;t save them.</span>
            )}
          </div>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">{VIEWS.map((v) => <Link key={v.id} href={q({ view: v.id })} className={`rounded-full px-3 py-1.5 text-sm font-bold ${view === v.id ? "bg-ink text-white" : "bg-white hover:bg-mist"}`}>{v.label}</Link>)}</div>
            <form action="/admin/support" className="flex gap-2">
              {queue && <input type="hidden" name="queue" value={queue} />}<input type="hidden" name="view" value={view} />
              <input name="q" defaultValue={sp.q} aria-label="Search tickets" placeholder="Search number, email, rental…" className="min-h-10 rounded-full border border-silver/70 px-4 text-sm" />
            </form>
          </div>

          {tickets.length === 0 ? (
            <EmptyCard title="Nothing here">No tickets match this view. New requests from /support/new and partner requests appear here instantly.</EmptyCard>
          ) : (
            <>
            <div className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              <table className="w-full min-w-[940px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr><th className="w-10 px-4 py-3"><span className="sr-only">Select</span></th>{["Ticket", "Requester", "Queue", "Priority", "Status", "Handling", "SLA", "Updated"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {tickets.map((t) => {
                    const sla = slaStatus(t, now);
                    const showSla = t.aiState !== "ai_active" && t.state !== "resolved" && t.state !== "closed";
                    return (
                      <tr key={t.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                        <td className="px-4 py-3"><input type="checkbox" name="numbers" form="bulk-form" value={t.number} aria-label={`Select ${t.number}`} /></td>
                        <td className="max-w-xs px-4 py-3"><Link href={`/admin/support/${t.number}`} className="font-bold underline-offset-4 hover:underline">{t.number}</Link><p className="truncate text-graphite">{t.subject}</p></td>
                        <td className="px-4 py-3"><p className="font-semibold">{t.name}</p><p className="text-xs text-graphite">{t.requesterType === "partner" ? `Partner${t.venueLabel ? ` · ${t.venueLabel}` : ""}` : t.email}</p></td>
                        <td className="px-4 py-3"><Pill tone={t.queue === "safety" ? "red" : t.queue === "billing" ? "gold" : t.queue === "partner" ? "cyan" : "mist"}>{t.queue}</Pill></td>
                        <td className="px-4 py-3"><Pill tone={PRIO_TONE[t.priority]}>{t.priority}</Pill></td>
                        <td className="px-4 py-3 text-xs font-bold">{t.state.replace("_", " ")}</td>
                        <td className="px-4 py-3"><Pill tone={t.aiState === "ai_active" ? "lime" : t.aiState === "needs_human" ? "gold" : "ink"}>{t.aiState === "ai_active" ? "AI" : t.aiState === "needs_human" ? "Needs person" : t.aiState === "human" ? (t.assignedTo === user?.id ? "You" : "Agent") : "New"}</Pill></td>
                        <td className="px-4 py-3">{showSla ? <Pill tone={SLA_TONE[t.firstResponseAt ? sla.resolution : sla.firstResponse]}>{t.firstResponseAt ? humanDue(t.resolutionDueAt, now) : humanDue(t.firstResponseDueAt, now)}</Pill> : <span className="text-xs text-graphite">—</span>}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{new Date(t.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4"><BulkBar staff={staffList} returnQuery={currentQuery} /></div>
            </>
          )}
          <p className="mt-4 text-xs text-graphite">SLA targets are internal and not published to customers. {tickets.length} ticket{tickets.length === 1 ? "" : "s"} shown.</p>
        </>
      )}
    </AdminGate>
  );
}
