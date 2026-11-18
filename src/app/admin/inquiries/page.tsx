export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Inquiries", robots: { index: false, follow: false } };
const QUEUES = ["all", "customer_support", "venue_partnerships", "advertising", "general"] as const;
const QUEUE_TONE = { venue_partnerships: "cyan", customer_support: "lime", advertising: "gold", general: "mist" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
type Inquiry = { id: string; queue: keyof typeof QUEUE_TONE; name: string; email: string; message: string; handled: boolean; created_at: string };

export default async function Inquiries({ searchParams }: { searchParams: Promise<{ result?: string; q?: string; queue?: string; view?: string; id?: string }> }) {
  const sp = await searchParams;
  const db = serviceClient();
  const res = db ? await db.from("contact_messages").select("id,queue,name,email,message,handled,created_at").order("created_at", { ascending: false }).limit(300) : null;
  const rows = (res?.data ?? []) as Inquiry[];
  const queue = QUEUES.includes(sp.queue as typeof QUEUES[number]) ? sp.queue! : "all";
  const view = sp.view === "handled" ? "handled" : "open";
  const query = (sp.q ?? "").trim().toLowerCase().slice(0, 100);
  const filtered = rows.filter((r) => (queue === "all" || r.queue === queue) && r.handled === (view === "handled")
    && (!query || [r.name, r.email, r.message].some((v) => v.toLowerCase().includes(query))));
  const selected = filtered.find((r) => r.id === sp.id) ?? filtered[0];
  const href = (change: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const values = { view, queue, q: sp.q, id: sp.id, ...change };
    for (const [key, value] of Object.entries(values)) if (value) p.set(key, value);
    return "/admin/inquiries?" + p.toString();
  };
  const open = rows.filter((r) => !r.handled).length;
  return <AdminGate title="Inquiries" nav="inquiries">
    {!db || res?.error ? <EmptyCard title="Contact data unavailable">{res?.error ? "The inquiry list could not load. Try again shortly." : "Connect Supabase to see live messages."}</EmptyCard> :
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-4 rounded-2xl bg-[#142126] p-6 text-white md:p-8">
        <div><p className="eyebrow text-lime">Contact intake</p><h2 className="mt-2 text-3xl font-bold tracking-tight">Every message has a next step.</h2><p className="mt-2 max-w-2xl text-sm text-[#b7c8c2]">Triage website inquiries, review the full message, then move the conversation into the right customer or partner workspace.</p></div>
        <Link href="/admin/receptionist" className="rounded-lg border border-white/25 px-4 py-2.5 text-sm font-bold hover:bg-white/10">Open email desk →</Link>
      </section>
      {sp.result && <p role="status" className={"rounded-xl px-4 py-3 text-sm font-bold " + (sp.result === "saved" ? "bg-lime" : "bg-red-100 text-red-900")}>{sp.result === "saved" ? "Inquiry status saved." : "Inquiry status could not be saved."}</p>}
      <section aria-label="Inquiry summary" className="grid gap-3 sm:grid-cols-3">
        {[["Needs review", open, "Open form submissions"], ["Handled", rows.length - open, "Completed intake"], ["Recent messages", rows.length, "Latest 300 records"]].map(([label, value, detail]) =>
          <div key={label} className="rounded-2xl border border-mist bg-white p-5"><p className="text-xs font-extrabold uppercase tracking-wider text-graphite">{label}</p><p className="mt-2 text-3xl font-bold">{value}</p><p className="mt-1 text-xs text-graphite">{detail}</p></div>)}
      </section>
      <section className="rounded-2xl border border-mist bg-white p-4" aria-label="Inquiry filters">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={href({ view: "open", id: undefined })} className={"rounded-lg px-4 py-2 text-sm font-bold " + (view === "open" ? "bg-ink text-white" : "bg-mist/60")}>Needs review</Link>
          <Link href={href({ view: "handled", id: undefined })} className={"rounded-lg px-4 py-2 text-sm font-bold " + (view === "handled" ? "bg-ink text-white" : "bg-mist/60")}>Handled</Link>
          <form action="/admin/inquiries" className="ml-auto flex min-w-[220px] flex-1 gap-2 sm:max-w-sm">
            <input type="hidden" name="view" value={view} /><input type="hidden" name="queue" value={queue} />
            <input name="q" defaultValue={sp.q} aria-label="Search inquiries" placeholder="Search name, email, message…" className="min-h-10 min-w-0 flex-1 rounded-lg border border-silver/70 px-3 text-sm" />
            <button className="rounded-lg bg-forest px-3 text-xs font-bold text-white">Search</button>
          </form>
        </div>
        <nav aria-label="Inquiry queues" className="mt-3 flex gap-2 overflow-x-auto border-t border-mist pt-3">
          {QUEUES.map((q) => <Link key={q} href={href({ queue: q, id: undefined })} className={"shrink-0 rounded-full px-3 py-1.5 text-xs font-bold " + (queue === q ? "bg-lime text-ink" : "bg-[#f2f5f1] text-graphite hover:bg-mist")}>{q === "all" ? "All queues" : q.replace(/_/g, " ")}</Link>)}
        </nav>
      </section>
      <div className="grid min-h-[540px] gap-4 lg:grid-cols-[minmax(290px,.8fr)_minmax(0,1.2fr)]">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-mist bg-white" aria-label="Inquiry list">
          <div className="border-b border-mist px-5 py-4"><h3 className="font-bold">{filtered.length} {view === "handled" ? "handled" : "open"} inquiries</h3></div>
          {filtered.length === 0 ? <p className="px-5 py-10 text-sm text-graphite">Nothing matches these filters. Try another queue or search.</p> :
          <ul className="max-h-[720px] divide-y divide-mist overflow-y-auto">{filtered.map((r) =>
            <li key={r.id}><Link href={href({ id: r.id })} className={"block border-l-4 px-5 py-4 hover:bg-[#f3f8ee] " + (selected?.id === r.id ? "border-lime bg-[#f3f8ee]" : "border-transparent")}>
              <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-bold">{r.name}</span><span className="shrink-0 text-xs text-graphite">{when(r.created_at)}</span></div>
              <p className="mt-1 truncate text-xs text-graphite">{r.email}</p>
              <p className="mt-2 line-clamp-2 text-sm leading-5">{r.message}</p>
              <div className="mt-2"><Pill tone={QUEUE_TONE[r.queue] ?? "mist"}>{r.queue.replace(/_/g, " ")}</Pill></div>
            </Link></li>)}</ul>}
        </section>
        <section className="min-w-0 rounded-2xl border border-mist bg-white" aria-label="Inquiry detail">
          {!selected ? <div className="p-8 text-sm text-graphite">Select an inquiry to read it here.</div> : <>
            <div className="border-b border-mist p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow text-forest">Website inquiry</p><h3 className="mt-2 text-2xl font-bold">{selected.name}</h3><p className="mt-1 text-sm text-graphite">{selected.email}</p></div><Pill tone={selected.handled ? "lime" : "gold"}>{selected.handled ? "Handled" : "Needs review"}</Pill></div><p className="mt-3 text-xs text-graphite">Received {when(selected.created_at)} · {selected.queue.replace(/_/g, " ")}</p></div>
            <div className="p-6"><h4 className="text-xs font-extrabold uppercase tracking-wider text-graphite">Message</h4><p className="mt-3 whitespace-pre-wrap text-sm leading-7">{selected.message}</p></div>
            <div className="border-t border-mist p-6"><p className="text-xs font-extrabold uppercase tracking-wider text-graphite">Next actions</p><div className="mt-3 flex flex-wrap gap-2">
              <Link href={"/admin/customers/" + encodeURIComponent(selected.email)} className="rounded-lg bg-ink px-4 py-2.5 text-xs font-bold text-white">Open customer record →</Link>
              <Link href={"/admin/receptionist?q=" + encodeURIComponent(selected.email)} className="rounded-lg border border-mist px-4 py-2.5 text-xs font-bold">Find email thread</Link>
              <form method="post" action="/api/admin/inquiries"><input type="hidden" name="id" value={selected.id} /><input type="hidden" name="handled" value={String(!selected.handled)} /><button className="rounded-lg bg-lime px-4 py-2.5 text-xs font-bold">Mark {selected.handled ? "open" : "handled"}</button></form>
            </div><p className="mt-3 text-xs text-graphite">The status action tracks intake. Use the customer record or email desk to continue support work.</p></div>
          </>}
        </section>
      </div>
    </div>}
  </AdminGate>;
}
