export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { fmt } from "@/lib/pricing";
import { disputeUrl } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Disputes", robots: { index: false, follow: false } };

type Dispute = {
  id: string; stripe_dispute_id: string | null; status: string | null; amount_cents: number | null; reason: string | null;
  opened_at: string; resolved_at: string | null; evidence_due_by: string | null;
  payments: { rentals: { reference: string } | null } | null;
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

export default async function Disputes() {
  const db = serviceClient();
  const { data } = db ? await db.from("disputes").select("id,stripe_dispute_id,status,amount_cents,reason,opened_at,resolved_at,evidence_due_by,payments(rentals(reference))").order("opened_at", { ascending: false }).limit(200) : { data: null };
  const rows = (data ?? []) as unknown as Dispute[];
  const soon = (iso: string | null) => !!iso && !Number.isNaN(new Date(iso).getTime()) && new Date(iso).getTime() - Date.now() < 3 * 86400_000;

  return (
    <AdminGate title="Disputes" nav="disputes">
      {!db ? <EmptyCard title="Dispute data not connected">Connect Supabase to see disputes.</EmptyCard> : (
        <section aria-label="Disputes" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
          {rows.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No disputes recorded. They appear here when Stripe sends a dispute webhook.</p> : (
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                <tr>{["Rental", "Status", "Amount", "Reason", "Opened", "Evidence due", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const open = !d.resolved_at;
                  return (
                    <tr key={d.id} className="border-b border-mist/70 last:border-0">
                      <td className="px-4 py-3 font-bold">{d.payments?.rentals?.reference ?? "—"}</td>
                      <td className="px-4 py-3"><Pill tone={open ? "red" : "mist"}>{(d.status ?? "unknown").replace(/_/g, " ")}</Pill></td>
                      <td className="px-4 py-3">{d.amount_cents === null ? "—" : fmt(d.amount_cents)}</td>
                      <td className="px-4 py-3 text-xs">{(d.reason ?? "—").replace(/_/g, " ")}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(d.opened_at)}</td>
                      <td className={`px-4 py-3 text-xs ${open && soon(d.evidence_due_by) ? "font-bold text-red-700" : "text-graphite"}`}>{when(d.evidence_due_by)}</td>
                      <td className="px-4 py-3">{d.stripe_dispute_id && <a href={disputeUrl(d.stripe_dispute_id)} target="_blank" rel="noopener noreferrer" className="text-xs font-bold underline">Open in Stripe</a>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
    </AdminGate>
  );
}
