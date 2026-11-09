export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Inquiries", robots: { index: false, follow: false } };
const QUEUE_TONE = { venue_partnerships: "cyan", customer_support: "lime", advertising: "gold", general: "mist" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default async function Inquiries({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const feedback = await searchParams;
  const db = serviceClient();
  const res = db ? await db.from("contact_messages").select("id,queue,name,email,message,handled,created_at").order("created_at", { ascending: false }).limit(300) : null;
  const rows = (res?.data ?? []) as { id: string; queue: keyof typeof QUEUE_TONE; name: string; email: string; message: string; handled: boolean; created_at: string }[];

  return (
    <AdminGate title="Inquiries" nav="inquiries">
      {!db ? (
        <EmptyCard title="Contact data not connected">Connect Supabase to see live messages.</EmptyCard>
      ) : (
        <div className="space-y-6">
          {feedback.result && <p role="status" className={`rounded-xl px-4 py-3 text-sm font-bold ${feedback.result === "saved" ? "bg-lime" : "bg-red-100 text-red-900"}`}>{feedback.result === "saved" ? "Inquiry status saved." : "Inquiry status could not be saved."}</p>}
          <section aria-label="Inquiry summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Total messages" value={rows.length} />
            <Metric label="Unhandled" value={rows.filter((r) => !r.handled).length} sub="Needs a reply" />
            <Metric label="Partnership" value={rows.filter((r) => r.queue === "venue_partnerships").length} />
            <Metric label="Advertising" value={rows.filter((r) => r.queue === "advertising").length} />
          </section>

          <section aria-label="Messages" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Contact messages</h2></div>
            {rows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No messages yet. Submissions from the contact form land here.</p>
            ) : (
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["From", "Queue", "Message", "Status", "Received"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3"><p className="font-bold">{r.name}</p><p className="text-xs text-graphite">{r.email}</p></td>
                      <td className="px-4 py-3"><Pill tone={QUEUE_TONE[r.queue] ?? "mist"}>{r.queue.replace("_", " ")}</Pill></td>
                      <td className="max-w-md px-4 py-3"><p className="line-clamp-2 text-xs text-graphite">{r.message}</p></td>
                      <td className="px-4 py-3"><form method="post" action="/api/admin/inquiries" className="flex items-center gap-2"><input type="hidden" name="id" value={r.id} /><input type="hidden" name="handled" value={String(!r.handled)} /><Pill tone={r.handled ? "lime" : "gold"}>{r.handled ? "handled" : "open"}</Pill><button className="rounded-full bg-mist px-3 py-1.5 text-xs font-bold hover:bg-lime">Mark {r.handled ? "open" : "handled"}</button></form></td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(r.created_at)}</td>
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
