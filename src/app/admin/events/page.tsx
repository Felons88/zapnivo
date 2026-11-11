export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";
import { PassLookup } from "./PassLookup";
import { GroupCreditForm } from "./GroupCreditForm";

export const metadata: Metadata = { title: "Events & groups", robots: { index: false, follow: false } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
const fmt = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
const input = "min-h-9 rounded-lg border border-silver/70 px-2 text-xs";

type EventRow = {
  id: string; name: string; status: string; starts_at: string; ends_at: string;
  price_cents: number | null; max_redemptions: number | null; organizer_id: string;
  profiles: { email: string | null } | { email: string | null }[] | null;
};
type GroupRow = { id: string; name: string; status: string; credit_cents: number; max_members: number; organizer_id: string };

export default async function AdminEvents({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  const sp = await searchParams;
  const db = serviceClient();

  const [eventsRes, groupsRes] = db
    ? await Promise.all([
        db.from("event_programs")
          .select("id,name,status,starts_at,ends_at,price_cents,max_redemptions,organizer_id,profiles!event_programs_organizer_id_fkey(email)")
          .order("starts_at", { ascending: false }).limit(200),
        db.from("rental_groups").select("id,name,status,credit_cents,max_members,organizer_id").order("created_at", { ascending: false }).limit(200),
      ])
    : [null, null];
  const events = (eventsRes?.data ?? []) as unknown as EventRow[];
  const groups = (groupsRes?.data ?? []) as GroupRow[];
  const one = <T,>(v: T | T[] | null) => (Array.isArray(v) ? v[0] : v);
  const active = events.filter((e) => e.status === "active").length;

  return (
    <AdminGate title="Events & groups" nav="fleet">
      {!db ? <EmptyCard title="Data not connected">Connect Supabase.</EmptyCard> : (
        <div className="space-y-8">
          {sp.done && <p className="rounded-xl bg-lime px-4 py-2.5 text-sm font-bold text-ink">Done ({sp.done}).</p>}

          <section className="grid gap-4 sm:grid-cols-3">
            <Metric label="Events" value={events.length} />
            <Metric label="Active now" value={active} />
            <Metric label="Groups" value={groups.length} />
          </section>

          <PassLookup />

          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Event programs</h2></div>
            {events.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No events yet.</p> : (
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Event", "Organizer", "Window", "Price", "Status", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {events.map((e) => {
                    const org = one(e.profiles);
                    const next: Record<string, string[]> = {
                      draft: ["active", "cancelled"], active: ["paused", "closed", "cancelled"],
                      paused: ["active", "closed", "cancelled"], closed: [], cancelled: [],
                    };
                    return (
                      <tr key={e.id} className="border-b border-mist/70 last:border-0">
                        <td className="px-4 py-3 font-bold">{e.name}<div className="text-xs font-normal text-graphite">{e.max_redemptions ? `cap ${e.max_redemptions}` : "uncapped"}</div></td>
                        <td className="px-4 py-3 text-xs text-graphite">{org?.email ?? e.organizer_id.slice(0, 8)}</td>
                        <td className="px-4 py-3 text-xs">{when(e.starts_at)} → {when(e.ends_at)}</td>
                        <td className="px-4 py-3">
                          <form method="post" action="/api/admin/events" className="flex items-center gap-1">
                            <input type="hidden" name="action" value="set_price" /><input type="hidden" name="event_id" value={e.id} />
                            <input name="price_cents" required type="number" min={1} defaultValue={e.price_cents ?? ""} placeholder="cents" className={`${input} w-24`} />
                            <button className="min-h-9 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Set</button>
                          </form>
                        </td>
                        <td className="px-4 py-3"><Pill tone={e.status === "active" ? "lime" : "mist"}>{e.status}</Pill></td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {(next[e.status] ?? []).map((to) => (
                              <form key={to} method="post" action="/api/admin/events">
                                <input type="hidden" name="action" value="set_status" /><input type="hidden" name="event_id" value={e.id} /><input type="hidden" name="to" value={to} />
                                <button className={`min-h-8 rounded-full px-3 text-xs font-bold ${to === "cancelled" ? "border border-red-300 text-red-700" : "bg-mist hover:bg-lime"}`}>{to}</button>
                              </form>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Rental groups — credit pools</h2></div>
            <p className="border-b border-mist px-6 py-2 text-xs text-graphite">Self-serve funding isn&apos;t available yet — staff adjustments here are the only funding path and are fully audited.</p>
            {groups.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No groups yet.</p> : (
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Group", "Status", "Members cap", "Pool", "Adjust (± cents)"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.id} className="border-b border-mist/70 last:border-0">
                      <td className="px-4 py-3 font-bold">{g.name}<div className="text-xs font-normal text-graphite">{g.organizer_id.slice(0, 8)}</div></td>
                      <td className="px-4 py-3"><Pill tone={g.status === "active" ? "lime" : "mist"}>{g.status}</Pill></td>
                      <td className="px-4 py-3">{g.max_members}</td>
                      <td className="px-4 py-3 font-bold">{fmt(g.credit_cents)}</td>
                      <td className="px-4 py-3"><GroupCreditForm groupId={g.id} balance={g.credit_cents} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </AdminGate>
  );
}
