export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/AdminCards";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Inquiries", robots: { index: false, follow: false } };
const QUEUE_TONE = { venue_partnerships: "cyan", customer_support: "lime", advertising: "gold", general: "mist" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default async function Inquiries() {
  const db = serviceClient();
  const res = db ? await db.from("contact_messages").select("id,queue,name,email,message,handled,created_at").order("created_at", { ascending: false }).limit(300) : null;
  const rows = (res?.data ?? []) as { id: string; queue: keyof typeof QUEUE_TONE; name: string; email: string; message: string; handled: boolean; created_at: string }[];

  return (
    <AdminGate title="Inquiries" nav="inquiries">
      {!db ? (
        <EmptyCard title="Contact data not connected">Connect Supabase to see live messages.</EmptyCard>
      ) : (
        <div className="space-y-6">
          <section aria-label="Inquiry summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Total messages" value={rows.length} />
            <Metric label="Unhandled" value={rows.filter((r) => !r.handled).length} sub="Needs a reply" />
            <Metric label="Partnership" value={rows.filter((r) => r.queue === "venue_partnerships").length} />
            <Metric label="Advertising" value={rows.filter((r) => r.queue === "advertising").length} />
          </section>

          <section aria-label="Messages" className="overflow-x-auto rounded-2xl border border-white/10 bg-[#181933] shadow-sm">
            <div className="border-b border-white/10 px-6 py-4"><h2 className="font-display text-lg font-bold">Contact messages</h2></div>
            {rows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-silver">No messages yet. Submissions from the contact form land here.</p>
            ) : (
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-white/10 bg-white/5 text-xs uppercase tracking-wider text-silver">
                  <tr>{["From", "Queue", "Message", "Status", "Received"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-white/10 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3"><p className="font-bold">{r.name}</p><p className="text-xs text-silver">{r.email}</p></td>
                      <td className="px-4 py-3"><Pill tone={QUEUE_TONE[r.queue] ?? "mist"}>{r.queue.replace("_", " ")}</Pill></td>
                      <td className="max-w-md px-4 py-3"><p className="line-clamp-2 text-xs text-silver">{r.message}</p></td>
                      <td className="px-4 py-3"><Pill tone={r.handled ? "lime" : "gold"}>{r.handled ? "handled" : "open"}</Pill></td>
                      <td className="px-4 py-3 text-xs text-silver">{when(r.created_at)}</td>
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
