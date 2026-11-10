export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { smsConfigured } from "@/lib/sms";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "SMS log", robots: { index: false, follow: false } };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const TONE = { inbound: "cyan", outbound: "mist" } as const;

export default async function SmsLog() {
  const db = serviceClient();
  const res = db ? await db.from("sms_messages").select("id,direction,from_number,to_number,body,status,created_at").order("created_at", { ascending: false }).limit(200) : null;
  const rows = (res?.data ?? []) as { id: string; direction: keyof typeof TONE; from_number: string; to_number: string; body: string; status: string; created_at: string }[];
  return (
    <AdminGate title="SMS log" nav="sms">
      {!smsConfigured() && <p className="mb-4 rounded-xl bg-gold/40 px-4 py-3 text-sm font-bold">Twilio isn't configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER. Messages queue nowhere: sends are skipped until configured.</p>}
      <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
        {rows.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No messages yet. Rental lifecycle texts and inbound replies appear here with their delivery status.</p> : (
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["When", "Dir", "From → To", "Status", "Message"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-b border-mist/70 align-top last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-graphite">{when(m.created_at)}</td>
                  <td className="px-4 py-3"><Pill tone={TONE[m.direction]}>{m.direction}</Pill></td>
                  <td className="px-4 py-3 text-xs font-semibold">{m.from_number} → {m.to_number}</td>
                  <td className={`px-4 py-3 text-xs font-bold ${m.status === "failed" ? "text-red-700" : m.status === "delivered" || m.status === "received" ? "text-forest" : ""}`}>{m.status}</td>
                  <td className="max-w-md px-4 py-3 text-xs">{m.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AdminGate>
  );
}
