export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/AdminCards";
import { RefundActions } from "@/components/RefundActions";
import { getSessionUser } from "@/lib/auth";
import { defaultCtx } from "@/lib/helpdesk/service";

export const metadata: Metadata = { title: "Refund queue", robots: { index: false, follow: false } };

export default async function RefundQueue() {
  const user = await getSessionUser();
  const ctx = await defaultCtx();
  const open = ctx ? await ctx.repo.listRefunds({ status: ["requested", "approved", "failed"] }) : [];
  const done = ctx ? (await ctx.repo.listRefunds({ status: ["issued", "denied"] })).slice(0, 20) : [];
  const tickets = ctx ? new Map((await ctx.repo.listTickets({ limit: 500, states: ["open", "pending_customer", "pending_internal", "resolved", "closed"] })).map((t) => [t.id, t.number])) : new Map<string, string>();
  const role = user?.role === "admin" ? "admin" : "staff";

  return (
    <AdminGate title="Refund queue" nav="refunds">
      {!ctx || !user ? <EmptyCard title="Support system not connected">Connect Supabase or enable the dev store.</EmptyCard> : (
        <div className="space-y-8">
          <p className="max-w-3xl text-sm text-silver">Agents approve up to the first-24-hour cap. Larger amounts need an admin who did not request them. Refunds are issued through Stripe once linked; until then approved refunds wait here and can be recorded after issuing manually in Stripe.</p>
          <section aria-label="Open refunds">
            <h2 className="mb-3 font-display text-xl font-bold">Needs action ({open.length})</h2>
            {open.length === 0 ? <EmptyCard title="No open refunds">Refund requests created from tickets appear here.</EmptyCard> : (
              <div className="grid gap-3 lg:grid-cols-2">{open.map((r) => <div key={r.id}><Link href={`/admin/support/${tickets.get(r.ticketId) ?? ""}`} className="mb-1 inline-block text-xs font-bold underline">Ticket {tickets.get(r.ticketId) ?? "—"}</Link><RefundActions r={r} role={role} myId={user.id} /></div>)}</div>
            )}
          </section>
          {done.length > 0 && <section aria-label="Recently closed"><h2 className="mb-3 font-display text-xl font-bold">Recently closed</h2><div className="grid gap-3 lg:grid-cols-2">{done.map((r) => <RefundActions key={r.id} r={r} role={role} myId={user.id} />)}</div></section>}
        </div>
      )}
    </AdminGate>
  );
}
