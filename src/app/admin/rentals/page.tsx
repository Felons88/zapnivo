export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Rentals", robots: { index: false, follow: false } };

const STATE_TONE = { active: "lime", dispense_pending: "cyan", authorized: "cyan", returned: "mist", unreturned: "red", cancelled: "mist", charged_off: "gold" } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

export default async function Rentals() {
  const db = serviceClient();
  const [rentals, payments] = db ? await Promise.all([
    db.from("rentals").select("id,reference,state,started_at,dispensed_at,returned_at,non_return_deadline,created_at,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city))").order("created_at", { ascending: false }).limit(200),
    db.from("payments").select("rental_id,state,amount_captured_cents,amount_authorized_cents").limit(5000),
  ]) : [null, null];

  type Rental = { id: string; reference: string; state: keyof typeof STATE_TONE; started_at: string | null; dispensed_at: string | null; returned_at: string | null; non_return_deadline: string | null; created_at: string; kiosks: { station_id: string; venues: { name: string; city: string } | null } | null };
  const rows = (rentals?.data ?? []) as unknown as Rental[];
  const payBy = new Map<string, { state: string; amount_captured_cents: number | null; amount_authorized_cents: number | null }>();
  for (const p of (payments?.data ?? []) as { rental_id: string; state: string; amount_captured_cents: number | null; amount_authorized_cents: number | null }[]) payBy.set(p.rental_id, p);

  const active = rows.filter((r) => r.state === "active" || r.state === "dispense_pending").length;
  const unreturned = rows.filter((r) => r.state === "unreturned" || (r.non_return_deadline && !r.returned_at && new Date(r.non_return_deadline) < new Date())).length;
  const captured = (payments?.data ?? []).reduce((a: number, p: { amount_captured_cents: number | null }) => a + (p.amount_captured_cents ?? 0), 0);

  return (
    <AdminGate title="Rentals" nav="rentals">
      {!db ? (
        <EmptyCard title="Rental data not connected">Connect Supabase to see live rental records.</EmptyCard>
      ) : (
        <div className="space-y-6">
          <section aria-label="Rental summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Total rentals" value={rows.length} />
            <Metric label="Active now" value={active} />
            <Metric label="Unreturned / overdue" value={unreturned} sub="72h window tracked per rental" />
            <Metric label="Captured" value={fmt(captured)} sub="Sum of captured payments" />
          </section>

          <section aria-label="Rental records" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Rental records</h2></div>
            {rows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No rentals yet. The first rental appears here the moment a customer dispenses.</p>
            ) : (
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Reference", "Station", "State", "Started", "Returned", "Due back", "Payment", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const p = payBy.get(r.id);
                    const overdue = r.non_return_deadline && !r.returned_at && new Date(r.non_return_deadline) < new Date();
                    return (
                      <tr key={r.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                        <td className="px-4 py-3 font-bold">{r.reference}</td>
                        <td className="px-4 py-3"><p className="font-semibold">{r.kiosks?.venues?.name ?? r.kiosks?.station_id ?? "—"}</p><p className="text-xs text-graphite">{r.kiosks?.venues?.city ?? ""}</p></td>
                        <td className="px-4 py-3"><Pill tone={overdue ? "red" : STATE_TONE[r.state] ?? "mist"}>{overdue ? "overdue" : r.state.replace("_", " ")}</Pill></td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(r.started_at ?? r.created_at)}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(r.returned_at)}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(r.non_return_deadline)}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{p ? `${fmt(p.amount_captured_cents ?? p.amount_authorized_cents ?? 0)} · ${p.state}` : "—"}</td>
                        <td className="px-4 py-3">
                          {(r.state === "authorized" || r.state === "dispense_pending") && (
                            <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="dispense" /><button className="min-h-8 rounded-full bg-lime px-3 text-xs font-bold text-ink">Confirm dispense</button></form>
                          )}
                          {(r.state === "active" || r.state === "unreturned") && (
                            <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="return" /><button className="min-h-8 rounded-full border border-silver/60 px-3 text-xs font-bold hover:border-ink">Record return</button></form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </AdminGate>
  );
}
