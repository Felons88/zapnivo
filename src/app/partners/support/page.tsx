export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyCard, PortalGate } from "@/components/PortalShell";
import { PartnerRequestForm } from "@/components/PartnerRequestForm";
import { Pill } from "@/components/SupportNav";
import { getSessionUser } from "@/lib/auth";
import { defaultCtx } from "@/lib/helpdesk/service";

export const metadata: Metadata = { title: "Partner support", robots: { index: false, follow: false } };

const TABS = [{ href: "/partners", label: "Overview" }, { href: "/partners/payouts", label: "Payouts" }, { href: "/partners/support", label: "Support" }];
const STATE: Record<string, string> = { open: "Received", pending_customer: "Waiting for you", pending_internal: "In progress", resolved: "Resolved", closed: "Closed" };

export default async function PartnerSupport() {
  const user = await getSessionUser();
  const ctx = await defaultCtx();
  const isPartner = user?.role === "partner" && !!user.organizationId;
  const tickets = ctx && isPartner ? await ctx.repo.listTickets({ orgId: user!.organizationId!, limit: 100 }) : [];

  return (
    <PortalGate require="partner" eyebrow="Venue partner" title="Partner support" tabs={TABS}>
      {!ctx ? <EmptyCard title="Support system not connected">Partner requests will be available once the support system is connected.</EmptyCard>
        : !isPartner ? <EmptyCard title="Partner view">Sign in with a venue partner account to raise and track requests. Staff manage partner requests in the admin Support inbox.</EmptyCard>
        : (
          <div className="grid gap-8 lg:grid-cols-[1.2fr_.8fr]">
            <section aria-label="Your requests">
              <h2 className="font-display text-xl font-bold">Your requests</h2>
              {tickets.length === 0 ? <div className="mt-4"><EmptyCard title="No requests yet">Open a request for anything about your station: it's offline, a hardware issue, a placement change, a statement question, or a guest complaint.</EmptyCard></div> : (
                <ul className="mt-4 space-y-3">
                  {tickets.map((t) => (
                    <li key={t.id}><Link href={`/partners/support/${t.number}`} className="block rounded-xl border border-mist bg-white p-4 shadow-sm hover:border-forest">
                      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-bold">{t.number} · {t.category}</span><Pill tone={t.state === "resolved" || t.state === "closed" ? "lime" : t.state === "pending_customer" ? "gold" : "mist"}>{STATE[t.state] ?? t.state}</Pill></div>
                      <p className="mt-1 truncate text-sm text-graphite">{t.subject}</p>
                    </Link></li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="New request" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-xl font-bold">New request</h2>
              <p className="mb-5 mt-1 text-sm text-graphite">Goes straight to Zapnivo partner relations. Guests with rental problems should use support.zapnivo.com. Rental charges and refunds are handled by Zapnivo.</p>
              <PartnerRequestForm venues={[]} />
            </section>
          </div>
        )}
    </PortalGate>
  );
}
