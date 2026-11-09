export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Advertising", robots: { index: false, follow: false } };

const STATE_TONE = { new: "cyan", draft: "mist", pending_approval: "gold", approved: "lime", scheduled: "cyan", live: "lime", paused: "gold", taken_down: "red" } as const;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default async function AdminAds() {
  const db = serviceClient();
  const [inquiries, campaigns] = db ? await Promise.all([
    db.from("advertising_inquiries").select("id,company_name,contact_name,email,goals,budget,state,created_at").order("created_at", { ascending: false }).limit(200),
    db.from("advertising_campaigns").select("id,advertiser,name,status,starts_at,ends_at").order("created_at", { ascending: false }).limit(100),
  ]) : [null, null];

  type Inq = { id: string; company_name: string; contact_name: string; email: string; goals: string; budget: string | null; state: string; created_at: string };
  const inqRows = (inquiries?.data ?? []) as unknown as Inq[];
  const campRows = (campaigns?.data ?? []) as { id: string; advertiser: string; name: string; status: string; starts_at: string | null; ends_at: string | null }[];

  return (
    <AdminGate title="Advertising" nav="advertising">
      {!db ? (
        <EmptyCard title="Advertising data not connected">Connect Supabase to see live inquiries and campaigns.</EmptyCard>
      ) : (
        <div className="space-y-6">
          <section aria-label="Advertising summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Inquiries" value={inqRows.length} sub={`${inqRows.filter((i) => i.state === "new").length} new`} />
            <Metric label="Campaigns" value={campRows.length} sub={`${campRows.filter((c) => c.status === "live").length} live`} />
            <Metric label="Awaiting approval" value={campRows.filter((c) => c.status === "pending_approval").length} />
            <Metric label="Taken down" value={campRows.filter((c) => c.status === "taken_down").length} />
          </section>

          <section aria-label="Inquiries" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Inquiries</h2></div>
            {inqRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No inquiries yet. Advertising inquiries submitted via /advertise appear here.</p>
            ) : (
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Company", "Contact", "Goals", "Budget", "State", "Received"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {inqRows.map((i) => (
                    <tr key={i.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{i.company_name}</td>
                      <td className="px-4 py-3"><p className="font-semibold">{i.contact_name}</p><p className="text-xs text-graphite">{i.email}</p></td>
                      <td className="max-w-xs px-4 py-3"><p className="truncate text-xs text-graphite">{i.goals}</p></td>
                      <td className="px-4 py-3 text-xs font-semibold">{i.budget ?? "—"}</td>
                      <td className="px-4 py-3"><Pill tone={i.state === "new" ? "cyan" : "mist"}>{i.state}</Pill></td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(i.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-label="Campaigns" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Campaigns</h2></div>
            {campRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No campaigns yet. Playback is only reported when a station confirms it.</p>
            ) : (
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Campaign", "Advertiser", "Status", "Runs"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {campRows.map((c) => (
                    <tr key={c.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 font-bold">{c.name}</td>
                      <td className="px-4 py-3 text-xs font-semibold">{c.advertiser}</td>
                      <td className="px-4 py-3"><Pill tone={c.status in STATE_TONE ? STATE_TONE[c.status as keyof typeof STATE_TONE] : "mist"}>{c.status.replace("_", " ")}</Pill></td>
                      <td className="px-4 py-3 text-xs text-graphite">{c.starts_at ? when(c.starts_at) : "—"} → {c.ends_at ? when(c.ends_at) : "—"}</td>
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
