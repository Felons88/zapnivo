export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getAdminStats, pick, total } from "@/lib/admin-stats";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { humanDue } from "@/lib/helpdesk/sla";
import { fmt } from "@/lib/pricing";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false, follow: false } };

const n = (v: number | null | undefined) => (v == null ? "—" : String(v));

function Card({ title, href, children }: { title: string; href?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">{title}</h2>
        {href && <Link href={href} className="text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Open →</Link>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4"><dt className="text-sm text-graphite">{k}</dt><dd className="font-display text-xl font-bold">{v}</dd></div>
);

export default async function AdminDashboard() {
  const ctx = await defaultCtx();
  const m = ctx ? await computeMetrics(ctx.repo) : null;
  const stats = await getAdminStats();
  const recent = ctx
    ? (await ctx.repo.listTickets({ limit: 200 })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)
    : [];
  const partnerTickets = ctx
    ? (await ctx.repo.listTickets({ queue: "partner", states: ["open", "pending_customer", "pending_internal"], limit: 5 }))
    : [];
  const now = new Date();
  const kiosksOnline = pick(stats?.kioskStates, "online");
  const kiosksTotal = total(stats?.kioskStates);
  const rentalsActive = pick(stats?.rentalStates, "active") + pick(stats?.rentalStates, "dispense_pending");

  return (
    <AdminGate title="Dashboard" nav="dashboard">
      <div className="space-y-6">
        <section aria-label="Business at a glance" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Stations online" value={`${n(kiosksOnline)}${kiosksTotal != null ? `/${kiosksTotal}` : ""}`} sub={`${pick(stats?.kioskStates, "offline")} offline · ${pick(stats?.kioskStates, "maintenance")} in maintenance`} />
          <Metric label="Active rentals" value={n(rentalsActive)} sub={`${n(stats?.rentalsToday)} new in last 24h · ${pick(stats?.rentalStates, "unreturned")} unreturned`} />
          <Metric label="Revenue captured" value={stats?.revenueCents ? fmt(stats.revenueCents.captured) : "—"} sub={stats?.revenueCents ? `${fmt(stats.revenueCents.refunded)} refunded` : "Awaiting payment integration"} />
          <Metric label="Open tickets" value={m ? m.open : "—"} sub={m ? `${m.needsHuman} need a person · ${m.unassigned} unassigned` : "Helpdesk not connected"} />
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
          <div className="space-y-6">
            <Card title="Latest activity" href="/admin/support">
              {recent.length === 0 ? (
                <p className="py-6 text-sm text-graphite">No tickets yet. New requests from support.zapnivo.com appear here instantly.</p>
              ) : (
                <ul className="-mx-6 -mb-4 divide-y divide-mist/80">
                  {recent.map((t) => (
                    <li key={t.id}>
                      <Link href={`/admin/support/${t.number}`} className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-mist/30">
                        <span className="w-20 shrink-0 font-bold">{t.number}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{t.subject}</span>
                          <span className="block truncate text-xs text-graphite">{t.name} · {t.requesterType}</span>
                        </span>
                        <span className="hidden sm:block"><Pill tone={t.queue === "safety" ? "red" : t.queue === "billing" ? "gold" : t.queue === "partner" ? "cyan" : "mist"}>{t.queue}</Pill></span>
                        <span className="hidden text-xs text-graphite md:block">{t.firstResponseAt ? humanDue(t.resolutionDueAt, now) : humanDue(t.firstResponseDueAt, now)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Partner & maintenance requests" href="/admin/support?queue=partner">
              {partnerTickets.length === 0 ? (
                <p className="py-6 text-sm text-graphite">No open partner requests. Station issues and maintenance reports from venues land here.</p>
              ) : (
                <ul className="-mx-6 -mb-4 divide-y divide-mist/80">
                  {partnerTickets.map((t) => (
                    <li key={t.id}>
                      <Link href={`/admin/support/${t.number}`} className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-mist/30">
                        <span className="w-20 shrink-0 font-bold">{t.number}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{t.subject}</span>
                          <span className="block truncate text-xs text-graphite">{t.venueLabel ?? t.name}</span>
                        </span>
                        <Pill tone={t.category.toLowerCase().includes("safety") || t.category.toLowerCase().includes("offline") ? "red" : "cyan"}>{t.category}</Pill>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-6">
            <Card title="Network" href="/admin/fleet">
              <dl className="space-y-3">
                <Row k="Venues live" v={`${pick(stats?.venues, "true")}${total(stats?.venues) != null ? `/${total(stats?.venues)}` : ""}`} />
                <Row k="Power banks in field" v={n(stats?.powerBanks)} />
                <Row k="Slots ready / charging / fault" v={`${pick(stats?.slotStates, "ready")} / ${pick(stats?.slotStates, "charging")} / ${pick(stats?.slotStates, "fault")}`} />
                <Row k="Maintenance visits logged" v={n(stats?.maintenanceVisits)} />
              </dl>
            </Card>

            <Card title="Intake" href="/admin/partners">
              <dl className="space-y-3">
                <Row k="Partner applications" v={`${pick(stats?.applicationStates, "new")} new${total(stats?.applicationStates) != null ? ` · ${total(stats?.applicationStates)} total` : ""}`} />
                <Row k="Advertising inquiries" v={`${pick(stats?.adInquiryStates, "new")} new${total(stats?.adInquiryStates) != null ? ` · ${total(stats?.adInquiryStates)} total` : ""}`} />
                <Row k="Unhandled contact messages" v={n(stats?.unhandledContacts)} />
              </dl>
            </Card>

            <Card title="Response" href="/admin/support/metrics">
              <dl className="space-y-3">
                <Row k="Avg first response" v={m?.avgFirstResponseHours == null ? "—" : `${m.avgFirstResponseHours}h`} />
                <Row k="Resolved" v={m?.resolved ?? "—"} />
                <Row k="Resolved by AI alone" v={m == null ? "—" : `${m.aiResolved}${m.aiDeflectionRate != null ? ` (${m.aiDeflectionRate}%)` : ""}`} />
              </dl>
            </Card>
          </div>
        </div>
      </div>
    </AdminGate>
  );
}
