export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ADMIN_TOOL_INDEX, AdminGate } from "@/components/AdminShell";
import { isStaff, getSessionUser } from "@/lib/auth";
import { likeEscape } from "@/lib/customer";
import { searchCustomers } from "@/lib/crm";
import { defaultCtx, searchStaffTickets } from "@/lib/helpdesk/service";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Search internal", robots: { index: false, follow: false } };

type RentalHit = { id: string; reference: string; state: string; created_at: string; kiosks: { station_id: string; venues: { name: string; city: string } | null } | null };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user)) redirect("/partners");

  const q = (await searchParams).q?.trim().slice(0, 100) ?? "";
  const ready = q.length >= 2;
  const db = serviceClient();
  const ctx = ready ? await defaultCtx() : null;
  const [customers, ticketHits, rentalsRes] = await Promise.all([
    ready && db ? searchCustomers(db, q) : Promise.resolve([]),
    ready && ctx ? searchStaffTickets(ctx, { kind: "staff", id: user.id, name: user.email, role: user.role as "admin" | "staff" }, q, 12) : Promise.resolve([]),
    ready && db ? db.from("rentals").select("id,reference,state,created_at,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city))")
      .ilike("reference", `%${likeEscape(q)}%`).order("created_at", { ascending: false }).limit(12) : Promise.resolve(null),
  ]);
  const rentals = (rentalsRes?.data ?? []) as unknown as RentalHit[];
  const tools = ready ? ADMIN_TOOL_INDEX.filter(({ group, label }) => `${group} ${label}`.toLowerCase().includes(q.toLowerCase())) : [];
  const count = customers.length + ticketHits.length + rentals.length + tools.length;

  return <AdminGate title="Search" nav="search">
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <p className="eyebrow text-forest">Across internal</p>
        <h2 className="mt-2 font-display text-2xl font-bold tracking-tight">Find records and tools</h2>
        <p className="mt-2 text-sm text-graphite">Search customers by name, email, phone or rental reference; find tickets, rentals and program tools in one place.</p>
      </div>
      <form action="/admin/search" className="flex gap-2 rounded-2xl border border-mist bg-white p-3 shadow-sm">
        <input name="q" defaultValue={q} autoFocus minLength={2} maxLength={100} aria-label="Search everything" placeholder="Name, email, phone, ticket number, rental reference or tool" className="min-h-10 min-w-0 flex-1 px-3 text-sm outline-none" />
        <button className="rounded-lg bg-ink px-5 text-sm font-bold text-white">Search</button>
      </form>
      {!ready ? <p className="text-sm text-graphite">Enter at least two characters to search.</p> : <>
        <p className="text-sm text-graphite">{count} result{count === 1 ? "" : "s"} for <b className="text-ink">{q}</b>{!db || !ctx ? " · Some data sources are not connected in this environment." : ""}</p>
        {count === 0 ? <div className="rounded-2xl border border-mist bg-white p-8 text-sm text-graphite">No matches. Try a shorter name, the last ten digits of a phone number, or a record reference.</div> : null}
        {customers.length > 0 && <section className="overflow-hidden rounded-2xl border border-mist bg-white shadow-sm">
          <h3 className="border-b border-mist px-5 py-4 font-display text-lg font-bold">Customers <span className="text-sm font-normal text-graphite">{customers.length}</span></h3>
          <ul className="divide-y divide-mist">{customers.slice(0, 12).map((c) => <li key={c.email}>
            <Link href={`/admin/customers/${encodeURIComponent(c.email)}`} className="flex items-center gap-4 px-5 py-3 hover:bg-lime/10">
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{c.names[0] ?? c.email}</span><span className="block truncate text-xs text-graphite">{c.email}{c.phones[0] ? ` · ${c.phones[0]}` : ""}</span></span>
              <span className="text-xs text-graphite">{c.openTickets} open tickets · {c.rentalCount} rentals</span><span aria-hidden>↗</span>
            </Link>
          </li>)}</ul>
        </section>}
        {ticketHits.length > 0 && <section className="overflow-hidden rounded-2xl border border-mist bg-white shadow-sm">
          <h3 className="border-b border-mist px-5 py-4 font-display text-lg font-bold">Support tickets <span className="text-sm font-normal text-graphite">{ticketHits.length}</span></h3>
          <ul className="divide-y divide-mist">{ticketHits.map((t) => <li key={t.id}>
            <Link href={`/admin/support/${t.number}`} className="flex items-center gap-4 px-5 py-3 hover:bg-lime/10"><span className="w-24 shrink-0 text-sm font-bold">{t.number}</span><span className="min-w-0 flex-1 truncate text-sm">{t.subject}</span><span className="text-xs text-graphite">{t.state.replace(/_/g, " ")}</span><span aria-hidden>↗</span></Link>
          </li>)}</ul>
        </section>}
        {rentals.length > 0 && <section className="overflow-hidden rounded-2xl border border-mist bg-white shadow-sm">
          <h3 className="border-b border-mist px-5 py-4 font-display text-lg font-bold">Rentals <span className="text-sm font-normal text-graphite">{rentals.length}</span></h3>
          <ul className="divide-y divide-mist">{rentals.map((r) => <li key={r.id} className="flex items-center gap-4 px-5 py-3 text-sm"><span className="w-24 shrink-0 font-bold">{r.reference}</span><span className="min-w-0 flex-1 truncate">{r.kiosks?.venues?.name ?? r.kiosks?.station_id ?? "Station unknown"}</span><span className="text-xs text-graphite">{r.state.replace(/_/g, " ")}</span><Link href={`/admin/rentals?q=${encodeURIComponent(r.reference)}`} className="font-bold text-forest underline">Open →</Link></li>)}</ul>
        </section>}
        {tools.length > 0 && <section className="overflow-hidden rounded-2xl border border-mist bg-white shadow-sm">
          <h3 className="border-b border-mist px-5 py-4 font-display text-lg font-bold">Programs and tools <span className="text-sm font-normal text-graphite">{tools.length}</span></h3>
          <ul className="grid gap-2 p-4 sm:grid-cols-2">{tools.map(({ group, label, href }) => <li key={href}><Link href={href} className="flex items-center justify-between rounded-xl bg-paper px-4 py-3 text-sm font-bold hover:bg-lime/20"><span><span className="mr-2 text-xs font-semibold text-graphite">{group}</span>{label}</span><span aria-hidden>↗</span></Link></li>)}</ul>
        </section>}
      </>}
    </div>
  </AdminGate>;
}
