export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { searchCustomers } from "@/lib/crm";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Customers", robots: { index: false, follow: false } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

export default async function Customers({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const db = serviceClient();
  const results = db && q.trim().length >= 2 ? await searchCustomers(db, q) : [];

  return (
    <AdminGate title="Customers" nav="customers">
      {!db ? (
        <EmptyCard title="Customer data not connected">Connect Supabase to search customer accounts.</EmptyCard>
      ) : (
        <div className="space-y-6">
          <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Find a customer</h2>
            <p className="mt-1 text-sm text-graphite">Search by name, email, phone number, or rental reference (e.g. ZR-1A2B3C4D). Phone numbers match in any format.</p>
            <form method="get" action="/admin/customers" className="mt-4 flex gap-3">
              <input
                name="q"
                defaultValue={q}
                autoFocus
                placeholder="Jane Smith · (555) 123-4567 · jane@email.com · ZR-…"
                aria-label="Customer search"
                className="min-h-11 flex-1 rounded-lg border border-silver/70 px-4 text-sm"
              />
              <button className="min-h-11 rounded-full bg-ink px-6 text-sm font-bold text-white">Search</button>
            </form>
          </section>

          {q.trim().length >= 2 && (
            <section aria-label="Results" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              <div className="border-b border-mist px-6 py-4">
                <h2 className="font-display text-lg font-bold">{results.length === 1 ? "1 customer" : `${results.length} customers`} <span className="text-sm font-semibold text-graphite">for “{q.trim()}”</span></h2>
              </div>
              {results.length === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No customer found. Check the spelling, try just the 10-digit phone number, or search by rental reference.</p>
              ) : (
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                    <tr>{["Customer", "Contact", "Found via", "Rentals", "Open tickets", "Last activity", ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {results.map((c) => (
                      <tr key={c.email} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
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
                          <Link href={`/admin/customers/${encodeURIComponent(c.email)}`} className="min-h-8 inline-flex items-center rounded-full bg-lime px-3 text-xs font-bold text-ink">Open 360°</Link>
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
