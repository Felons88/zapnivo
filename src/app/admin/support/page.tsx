export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser } from "@/lib/auth";
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

export default async function Inbox({ searchParams }: { searchParams: Promise<{ view?: string; queue?: string; q?: string }> }) {
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
  const q = (extra: Record<string, string>) => { const p = new URLSearchParams({ ...(queue ? { queue } : {}), ...extra }); return `/admin/support?${p}`; };

  const nav = queue === "partner" ? "partner" : queue === "safety" ? "safety" : "inbox";
  return (
    <AdminGate title={nav === "partner" ? "Partner relations" : nav === "safety" ? "Safety queue" : "Support inbox"} nav={nav}>
      {!ctx ? (
        <EmptyCard title="Support system not connected">Connect Supabase (and apply migrations 0001–0004), or for local development set <code>HELPDESK_DEV_STORE=1</code> and restart <code>npm run dev</code>.</EmptyCard>
      ) : (
        <>
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
            <div className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Ticket", "Requester", "Queue", "Priority", "Status", "Handling", "SLA", "Updated"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {tickets.map((t) => {
                    const sla = slaStatus(t, now);
                    const showSla = t.aiState !== "ai_active" && t.state !== "resolved" && t.state !== "closed";
                    return (
                      <tr key={t.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
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
          )}
          <p className="mt-4 text-xs text-graphite">SLA targets are internal and not published to customers. {tickets.length} ticket{tickets.length === 1 ? "" : "s"} shown.</p>
        </>
      )}
    </AdminGate>
  );
}
