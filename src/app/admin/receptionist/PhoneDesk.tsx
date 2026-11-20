import Link from "next/link";
import { Pill } from "@/components/SupportNav";
import { normalizePhone, smsConfigured } from "@/lib/sms";

export type PhoneMessage = { id: string; direction: string; from_number: string; to_number: string; body: string; status: string; created_at: string };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const contact = (m: PhoneMessage) => normalizePhone(m.direction === "inbound" ? m.from_number : m.to_number);

export function PhoneDesk({ rows, optedOutPhones, selectedPhone, q, result }: { rows: PhoneMessage[]; optedOutPhones: string[]; selectedPhone?: string; q?: string; result?: string }) {
  const inbound = new Set(rows.filter((m) => m.direction === "inbound").map(contact).filter((p): p is string => !!p));
  const conversations = [...inbound].map((phone) => {
    const messages = rows.filter((m) => contact(m) === phone);
    return { phone, messages, last: messages[0] };
  }).filter((c) => {
    if (!q) return true;
    const digits = q.replace(/\D/g, "");
    return (!!digits && c.phone.includes(digits)) || c.messages.some((m) => m.body.toLowerCase().includes(q.toLowerCase()));
  });
  const selected = conversations.find((c) => c.phone === selectedPhone) ?? conversations[0];
  const selectedOptedOut = !!selected && optedOutPhones.includes(selected.phone);
  const href = (phone: string) => "/admin/receptionist?channel=phone&phone=" + encodeURIComponent(phone) + (q ? "&q=" + encodeURIComponent(q) : "");
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-2xl border border-[#e3e8ee] bg-white p-5"><p className="eyebrow text-forest">Inbound contacts</p><p className="mt-2 text-2xl font-bold">{inbound.size}</p><p className="mt-1 text-xs text-graphite">Recent SMS conversations</p></div>
      <div className="rounded-2xl border border-[#e3e8ee] bg-white p-5"><p className="eyebrow text-forest">New texts</p><p className="mt-2 text-2xl font-bold">{rows.filter((m) => m.direction === "inbound").length}</p><p className="mt-1 text-xs text-graphite">Within the latest 500 messages</p></div>
      <div className="rounded-2xl border border-[#e3e8ee] bg-white p-5"><p className="eyebrow text-forest">Phone channel</p><p className="mt-2 text-sm font-bold">{smsConfigured() ? "SMS connected" : "SMS not configured"}</p><p className="mt-2 text-xs text-graphite">Voice calls are not connected to this desk.</p></div>
    </div>
    {result && <p role="status" className={"rounded-xl px-4 py-3 text-sm font-semibold " + (result === "sent" ? "bg-[#edeeff]" : "bg-gold/30")}>{result === "sent" ? "Reply sent and logged." : result === "opted_out" ? "This contact has opted out of texts." : "Message could not be sent. Review the SMS setup and try again."}</p>}
    <div className="grid min-h-[580px] gap-4 lg:grid-cols-[minmax(280px,.7fr)_minmax(0,1.3fr)]">
      <section className="overflow-hidden rounded-2xl border border-[#e3e8ee] bg-white" aria-label="Phone conversations">
        <form action="/admin/receptionist" className="flex gap-2 border-b border-[#e3e8ee] p-4"><input type="hidden" name="channel" value="phone" /><input name="q" defaultValue={q} aria-label="Search phone conversations" placeholder="Search number or message" className="min-h-10 min-w-0 flex-1 rounded-lg border border-silver/70 px-3 text-sm" /><button className="rounded-lg bg-[#0a2540] px-3 text-xs font-bold text-white">Search</button></form>
        {conversations.length === 0 ? <p className="p-4 text-sm text-graphite">No inbound phone messages match this search.</p> : <ul className="max-h-[700px] divide-y divide-mist overflow-y-auto">{conversations.map((c) =>
          <li key={c.phone}><Link href={href(c.phone)} className={"block border-l-4 px-5 py-4 hover:bg-[#f3f8ee] " + (selected?.phone === c.phone ? "border-[#635bff] bg-[#f3f8ee]" : "border-transparent")}><div className="flex items-center justify-between gap-2"><span className="text-sm font-bold">{c.phone}</span><span className="text-xs text-graphite">{when(c.last.created_at)}</span></div><p className="mt-2 line-clamp-2 text-sm text-graphite">{c.last.body}</p><p className="mt-2 text-xs font-semibold text-forest">{c.messages.length} messages</p></Link></li>)}</ul>}
      </section>
      <section className="min-w-0 rounded-2xl border border-[#e3e8ee] bg-white" aria-label="Selected phone conversation">
        {!selected ? <p className="p-8 text-sm text-graphite">Select a contact to review their messages.</p> : <>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e3e8ee] p-5"><div><p className="eyebrow text-forest">Phone / SMS</p><h3 className="mt-1 text-xl font-bold">{selected.phone}</h3><p className="mt-1 text-xs text-graphite">Latest message {when(selected.last.created_at)}</p></div><Link href={"/admin/customers?q=" + encodeURIComponent(selected.phone)} className="rounded-lg bg-[#eef1f5] px-3 py-2 text-xs font-bold">Find customer →</Link></div>
          <ol className="max-h-[460px] space-y-3 overflow-y-auto p-5">{[...selected.messages].reverse().map((m) => <li key={m.id} className={"max-w-[90%] rounded-xl p-3 text-sm " + (m.direction === "inbound" ? "border border-[#e3e8ee] bg-[#f5f7f4]" : "ml-auto bg-[#eaf4dc]")}><div className="mb-2 flex items-center justify-between gap-2"><Pill tone={m.direction === "inbound" ? "mist" : "lime"}>{m.direction}</Pill><span className="text-xs text-graphite">{when(m.created_at)}</span></div><p className="whitespace-pre-wrap leading-6">{m.body}</p><p className="mt-2 text-[11px] text-graphite">{m.status}</p></li>)}</ol>
          <div className="border-t border-[#e3e8ee] p-5"><p className="text-xs font-extrabold uppercase tracking-wider text-graphite">Reply by SMS</p><p className="mt-1 text-xs text-graphite">Replies are sent through Twilio and logged. Opt-outs remain enforced.</p>
            {selectedOptedOut && <p role="status" className="mt-3 rounded-lg bg-gold/30 px-3 py-2 text-xs font-bold">This number opted out of texts. Reply is unavailable until they send START.</p>}
            <form method="post" action="/api/admin/receptionist/phone/reply" className="mt-3 space-y-2"><input type="hidden" name="phone" value={selected.phone} /><textarea name="body" required minLength={1} maxLength={480} rows={4} placeholder="Write a concise reply…" aria-label="SMS reply" disabled={selectedOptedOut} className="w-full rounded-lg border border-silver/70 p-3 text-sm disabled:opacity-50" /><button disabled={!smsConfigured() || selectedOptedOut} className="rounded-lg bg-[#0a2540] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">Send SMS reply</button></form>
          </div>
        </>}
      </section>
    </div>
  </div>;
}
