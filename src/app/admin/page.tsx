export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { Metric } from "@/components/AdminCards";
import { Pill } from "@/components/SupportNav";
import { getAdminStats, pick, total } from "@/lib/admin-stats";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { humanDue } from "@/lib/helpdesk/sla";
import { fmt } from "@/lib/pricing";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false, follow: false } };

const n = (v: number | null | undefined) => (v == null ? "—" : String(v));
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const I = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" aria-hidden className="h-[18px] w-[18px]" {...stroke}>{children}</svg>;
const icons = {
  station: <I><rect x="2" y="7" width="17" height="10" rx="2" /><path d="M22 11v2" /><path d="m11 9-2 3h3l-2 3" /></I>,
  rental: <I><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></I>,
  revenue: <I><circle cx="12" cy="12" r="9" /><path d="M15.5 9.5c-.8-.8-2-1.3-3.5-1.3-2 0-3.5 1-3.5 2.4 0 3.2 7 1.6 7 4.8 0 1.4-1.5 2.4-3.5 2.4-1.5 0-2.7-.5-3.5-1.3" /><path d="M12 6.5v1.7m0 7.6v1.7" /></I>,
  inbox: <I><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.5 2 12v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5l-3.5-6.5A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.5Z" /></I>,
};

function Card({ title, href, children }: { title: string; href?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#181933] p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">{title}</h2>
        {href && <Link href={href} className="text-xs font-extrabold uppercase tracking-wider text-lime hover:underline">Open →</Link>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Row = ({ k, v }: { k: string; v: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4"><dt className="text-sm text-silver">{k}</dt><dd className="font-display text-xl font-bold">{v}</dd></div>
);

const QUICK_ACTIONS = [
  { href: "/admin/fleet", label: "Register kiosk" },
  { href: "/admin/partners", label: "Invite a partner" },
  { href: "/admin/partners", label: "Queue statements" },
  { href: "/admin/support", label: "Open inbox" },
  { href: "/admin/demo", label: "Preview demo" },
];

export default async function AdminDashboard() {
  const ctx = await defaultCtx();
  const m = ctx ? await computeMetrics(ctx.repo) : null;
  const stats = await getAdminStats();
  const all = ctx ? await ctx.repo.listTickets({ limit: 200 }) : [];
  const recent = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const partnerTickets = all.filter((t) => t.queue === "partner" && t.state !== "resolved" && t.state !== "closed").slice(0, 5);
  const now = new Date();

  // Real 14-day new-ticket volume
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (13 - i));
    return { day: d, count: 0 };
  });
  for (const t of all) {
    const c = new Date(t.createdAt); c.setHours(0, 0, 0, 0);
    const idx = Math.round((c.getTime() - days[0].day.getTime()) / 86400_000);
    if (idx >= 0 && idx < 14) days[idx].count++;
  }
  const peak = Math.max(1, ...days.map((d) => d.count));

  const kiosksOnline = pick(stats?.kioskStates, "online");
  const kiosksTotal = total(stats?.kioskStates);
  const rentalsActive = pick(stats?.rentalStates, "active") + pick(stats?.rentalStates, "dispense_pending");
  const attention = (m?.overdueFirstResponse ?? 0) + (m?.unassigned ?? 0);

  return (
    <AdminGate title="Dashboard" nav="dashboard">
      <div className="space-y-6">
        {attention > 0 && (
          <Link href="/admin/support" className="flex items-center gap-3 rounded-2xl border border-gold/40 bg-gold/15 px-5 py-3 text-sm font-bold text-ink hover:bg-gold/40">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-ink text-xs font-extrabold text-lime">!</span>
            {m!.unassigned > 0 && <span>{m!.unassigned} ticket{m!.unassigned === 1 ? "" : "s"} unassigned</span>}
            {m!.unassigned > 0 && m!.overdueFirstResponse > 0 && <span aria-hidden>·</span>}
            {m!.overdueFirstResponse > 0 && <span>{m!.overdueFirstResponse} overdue first response{m!.overdueFirstResponse === 1 ? "" : "s"}</span>}
            <span className="ml-auto text-xs font-extrabold uppercase tracking-wider">Open inbox →</span>
          </Link>
        )}

        <section aria-label="Business at a glance" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={icons.station} label="Stations online" value={`${n(kiosksOnline)}${kiosksTotal != null ? `/${kiosksTotal}` : ""}`} sub={`${pick(stats?.kioskStates, "offline")} offline · ${pick(stats?.kioskStates, "maintenance")} in maintenance`} />
          <Metric icon={icons.rental} label="Active rentals" value={n(rentalsActive)} sub={`${n(stats?.rentalsToday)} new in last 24h · ${pick(stats?.rentalStates, "unreturned")} unreturned`} />
          <Metric icon={icons.revenue} label="Revenue captured" value={stats?.revenueCents ? fmt(stats.revenueCents.captured) : "—"} sub={stats?.revenueCents ? `${fmt(stats.revenueCents.refunded)} refunded` : "Awaiting payment integration"} />
          <Metric icon={icons.inbox} label="Open tickets" value={m ? m.open : "—"} sub={m ? `${m.needsHuman} need a person · ${m.unassigned} unassigned` : "Helpdesk not connected"} />
        </section>

        <section aria-label="Quick actions" className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((a, i) => (
            <Link key={`${a.href}-${i}`} href={a.href} className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-extrabold uppercase tracking-wider text-white shadow-sm transition-colors hover:border-lime hover:bg-lime hover:text-ink">
              {a.label}
            </Link>
          ))}
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
          <div className="space-y-6">
            <Card title="Latest activity" href="/admin/support">
              {recent.length === 0 ? (
                <p className="py-6 text-sm text-silver">No tickets yet. New requests from support.zapnivo.com appear here instantly.</p>
              ) : (
                <ul className="-mx-6 -mb-4 divide-y divide-white/10">
                  {recent.map((t) => (
                    <li key={t.id}>
                      <Link href={`/admin/support/${t.number}`} className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-white/5">
                        <span className="w-20 shrink-0 font-bold">{t.number}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{t.subject}</span>
                          <span className="block truncate text-xs text-silver">{t.name} · {t.requesterType}</span>
                        </span>
                        <span className="hidden sm:block"><Pill tone={t.queue === "safety" ? "red" : t.queue === "billing" ? "gold" : t.queue === "partner" ? "cyan" : "mist"}>{t.queue}</Pill></span>
                        <span className="hidden text-xs text-silver md:block">{t.firstResponseAt ? humanDue(t.resolutionDueAt, now) : humanDue(t.firstResponseDueAt, now)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Partner & maintenance requests" href="/admin/support?queue=partner">
              {partnerTickets.length === 0 ? (
                <p className="py-6 text-sm text-silver">No open partner requests. Station issues and maintenance reports from venues land here.</p>
              ) : (
                <ul className="-mx-6 -mb-4 divide-y divide-white/10">
                  {partnerTickets.map((t) => (
                    <li key={t.id}>
                      <Link href={`/admin/support/${t.number}`} className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-white/5">
                        <span className="w-20 shrink-0 font-bold">{t.number}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{t.subject}</span>
                          <span className="block truncate text-xs text-silver">{t.venueLabel ?? t.name}</span>
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
            <Card title="Ticket volume · 14 days" href="/admin/support/metrics">
              <div className="flex h-24 items-end gap-1.5" role="img" aria-label={`New tickets per day for 14 days, peak ${peak}`}>
                {days.map((d, i) => (
                  <div key={i} className="group flex flex-1 flex-col items-center justify-end" title={`${d.day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${d.count}`}>
                    <span className="w-full rounded-t bg-violet/70 transition-colors group-hover:bg-forest" style={{ height: `${Math.max(4, (d.count / peak) * 100)}%` }} />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[10px] font-bold uppercase tracking-wider text-silver">
                <span>{days[0].day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                <span>{days[13].day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              </div>
            </Card>

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
