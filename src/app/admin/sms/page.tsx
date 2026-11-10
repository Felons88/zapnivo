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

export default async function SmsLog({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const sp = await searchParams;
  const db = serviceClient();
  const [tplRes, flagRes] = db ? await Promise.all([
    db.from("sms_templates").select("kind,body"),
    db.from("system_config").select("key,value").in("key", ["sms_enabled", "non_return_billing_enabled"]),
  ]) : [null, null];
  const tpls = Object.fromEntries(((tplRes?.data ?? []) as { kind: string; body: string }[]).map((t) => [t.kind, t.body]));
  const flags = Object.fromEntries(((flagRes?.data ?? []) as { key: string; value: string }[]).map((f) => [f.key, f.value]));
  const res = db ? await db.from("sms_messages").select("id,direction,from_number,to_number,body,status,created_at").order("created_at", { ascending: false }).limit(200) : null;
  const rows = (res?.data ?? []) as { id: string; direction: keyof typeof TONE; from_number: string; to_number: string; body: string; status: string; created_at: string }[];
  return (
    <AdminGate title="SMS log" nav="sms">
      {!smsConfigured() && <p className="mb-4 rounded-xl bg-gold/40 px-4 py-3 text-sm font-bold">Twilio isn't configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER. Messages queue nowhere: sends are skipped until configured.</p>}
      {sp.result && <p className="mb-4 rounded-xl bg-lime px-4 py-2.5 text-sm font-bold text-ink">{sp.result === "sent" ? "Test SMS sent." : sp.result === "notconfigured" ? "Twilio isn't configured — the test was skipped." : "Saved."}</p>}
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold">Emergency switches</h2>
          <div className="mt-4 space-y-4">
            {([["sms_enabled", "SMS sending", "Stops every automated text — jobs stay queued, nothing sends."], ["non_return_billing_enabled", "Non-return billing", "Blocks the $45 fee charge path until re-enabled."]] as const).map(([k, label, help]) => (
              <div key={k} className="flex items-center justify-between gap-4">
                <div><p className="text-sm font-bold">{label}</p><p className="text-xs text-graphite">{help}</p></div>
                <form method="post" action="/api/admin/sms">
                  <input type="hidden" name="action" value="set_flag" /><input type="hidden" name="key" value={k} />
                  <input type="hidden" name="value" value={flags[k] === "false" ? "true" : "false"} />
                  <button className={`min-h-9 rounded-full px-4 text-xs font-extrabold uppercase tracking-wider ${flags[k] === "false" ? "bg-red-600 text-white" : "bg-lime text-ink"}`}>{flags[k] === "false" ? "Off — enable" : "On — disable"}</button>
                </form>
              </div>
            ))}
          </div>
          <form method="post" action="/api/admin/sms" className="mt-5 flex items-end gap-3 border-t border-mist pt-4">
            <input type="hidden" name="action" value="test_send" />
            <div className="flex-1"><label htmlFor="test-to" className="mb-1 block text-xs font-bold">Send a test SMS</label><input id="test-to" name="to" required placeholder="+1 555 000 1234" className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm" /></div>
            <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Send</button>
          </form>
        </section>
        <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold">Message templates</h2>
          <p className="mt-1 text-xs text-graphite">Variables: {"{ref} {rate} {fee} {deadline} {charges}"}. Empty = built-in default.</p>
          <div className="mt-4 max-h-96 space-y-3 overflow-y-auto">
            {["activation", "reminder_1h", "reminder_3h", "reminder_6h", "reminder_12h", "warning_20h", "warning_23h", "deadline_24h"].map((k) => (
              <form key={k} method="post" action="/api/admin/sms" className="flex items-start gap-2">
                <input type="hidden" name="action" value="save_template" /><input type="hidden" name="kind" value={k} />
                <div className="flex-1"><label htmlFor={`tpl-${k}`} className="mb-1 block text-[11px] font-extrabold uppercase tracking-wider text-silver">{k.replace("_", " ")}</label>
                  <textarea id={`tpl-${k}`} name="body" rows={2} defaultValue={tpls[k] ?? ""} className="w-full rounded-lg border border-silver/70 px-3 py-2 text-xs" /></div>
                <button className="mt-5 min-h-8 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Save</button>
              </form>
            ))}
          </div>
        </section>
      </div>

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
