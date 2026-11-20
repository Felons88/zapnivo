export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { CustomerSearchBox } from "@/components/CustomerSearch";
import { searchCustomers } from "@/lib/crm";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser, isStaff } from "@/lib/auth";

export const metadata: Metadata = { title: "Customers", robots: { index: false, follow: false } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

export default async function Customers({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user)) redirect("/partners");
  const { q = "" } = await searchParams;
  const db = serviceClient();
  const results = db && q.trim().length >= 2 ? await searchCustomers(db, q) : [];
  const recentAccounts = db && q.trim().length < 2
    ? (await db.from("profiles").select("id,email,full_name,phone,created_at").eq("role", "customer").order("created_at", { ascending: false }).limit(25)).data ?? []
    : [];

  return (
    <AdminGate title="Customers" nav="customers">
      {!db ? (
        <EmptyCard title="Customer data not connected">Connect Supabase to search customer accounts.</EmptyCard>
      ) : (
        <div className="space-y-4">
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#101d22] px-5 py-4 text-white">
            <div className="min-w-0">
              <p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-[#635bff]">Customer intelligence</p>
              <h2 className="mt-1 text-lg font-bold tracking-tight">Find the whole story.</h2>
              <p className="mt-1 text-xs text-[#b7c8c2]">Name, email, phone, or rental reference — guests appear alongside accounts.</p>
            </div>
            <form method="get" action="/admin/customers" className="flex min-w-0 flex-1 gap-2 sm:max-w-md">
              <CustomerSearchBox initial={q} autoFocus />
              <button className="min-h-10 shrink-0 rounded-lg bg-[#635bff] px-4 text-sm font-bold text-white">Search</button>
            </form>
          </section>

          {q.trim().length < 2 && <section className="overflow-hidden rounded-2xl border border-[#e3e8ee] bg-white shadow-sm">
            <div className="border-b border-[#e3e8ee] px-4 py-4"><h2 className="font-display text-lg font-bold">Recent customer accounts</h2><p className="mt-1 text-xs text-graphite">Guest customers appear when you search their email, phone or rental reference.</p></div>
            {recentAccounts.length === 0 ? <p className="px-4 py-8 text-sm text-graphite">No customer accounts yet. Use search to look up guests and support contacts.</p> :
              <ul className="divide-y divide-mist">{recentAccounts.map((c) => <li key={c.id}>
                <Link href={`/admin/customers/${encodeURIComponent(c.email)}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-[#edeeff]">
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{c.full_name ?? c.email}</span><span className="block truncate text-xs text-graphite">{c.email}{c.phone ? ` · ${c.phone}` : ""}</span></span>
                  <span className="text-xs text-graphite">Joined {when(c.created_at)}</span><span className="text-sm font-bold text-forest">Open record →</span>
                </Link>
              </li>)}</ul>}
          </section>}

          {q.trim().length >= 2 && (
            <section aria-label="Results" className="overflow-x-auto rounded-2xl border border-[#e3e8ee] bg-white shadow-sm">
              <div className="border-b border-[#e3e8ee] px-4 py-4">
                <h2 className="font-display text-lg font-bold">{results.length === 1 ? "1 customer" : `${results.length} customers`} <span className="text-sm font-semibold text-graphite">for “{q.trim()}”</span></h2>
              </div>
              {results.length === 0 ? (
                <p className="px-4 py-8 text-sm text-graphite">No customer found. Check the spelling, try just the 10-digit phone number, or search by rental reference.</p>
              ) : (
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="border-b border-[#e3e8ee] bg-[#eef1f5]/40 text-xs uppercase tracking-wider text-graphite">
                    <tr>{["Customer", "Contact", "Found via", "Rentals", "Open tickets", "Last activity", ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {results.map((c) => (
                      <tr key={c.email} className="border-b border-[#e3e8ee]/70 last:border-0 hover:bg-[#edeeff]">
                        <td className="px-4 py-3">
                          <p className="font-bold">{c.names[0] ?? c.email}</p>
                          {c.hasAccount ? <Pill tone="lime">account</Pill> : <Pill tone="mist">guest</Pill>}
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-xs font-semibold">{c.email}</p>
                          {c.phones[0] && <p className="text-xs text-graphite">{c.phones[0]}</p>}
                        </td>
                        <td className="px-4 py-3 text-xs text-graphite">{c.sources.join(" · ")}</td>
                        <td className="px-4 py-3 font-semibold">{c.rentalCount}</td>
                        <td className="px-4 py-3">{c.openTickets > 0 ? <Pill tone="gold">{c.openTickets} open</Pill> : <span className="text-xs text-graphite">0</span>}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(c.lastActivity)}</td>
                        <td className="px-4 py-3">
                          <Link href={`/admin/customers/${encodeURIComponent(c.email)}`} className="min-h-8 inline-flex items-center rounded-full bg-[#635bff] px-3 text-xs font-bold text-white">Open 360°</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </div>
      )}
    </AdminGate>
  );
}
