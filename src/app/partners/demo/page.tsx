export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { PartnerGate } from "@/components/PartnerShell";
import { Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { fmt } from "@/lib/pricing";

export const metadata: Metadata = { title: "Portal preview", robots: { index: false, follow: false } };

/* ── Sample data for preview only — never written to the database ────────── */
const KIOSKS = [
  { id: "ZN-4K2A1", venue: "Northern Pour Bar", state: "online", rentals: 96, seen: "2 min ago" },
  { id: "ZN-7X9B4", venue: "Riverside Hotel — Lobby", state: "online", rentals: 74, seen: "5 min ago" },
  { id: "ZN-2F8C3", venue: "Skyline Events Center", state: "maintenance", rentals: 51, seen: "3 hrs ago" },
  { id: "ZN-9M3D7", venue: "Depot Coffee House", state: "online", rentals: 26, seen: "12 min ago" },
] as const;
const STATEMENTS = [
  { venue: "Northern Pour Bar", period: "June 2026", gross: 21480, commission: 5370 },
  { venue: "Riverside Hotel — Lobby", period: "June 2026", gross: 18320, commission: 4580 },
  { venue: "Skyline Events Center", period: "June 2026", gross: 11090, commission: 2773 },
  { venue: "Depot Coffee House", period: "June 2026", gross: 6110, commission: 1527 },
] as const;
const PAYOUTS = [
  { period: "May 2026", venue: "All venues", amount: 13240, status: "paid", paid: "Jun 15" },
  { period: "June 2026", venue: "All venues", amount: 14250, status: "scheduled", paid: null },
] as const;
const VENUES = [
  { name: "Northern Pour Bar", city: "St. Cloud, MN", published: true },
  { name: "Riverside Hotel — Lobby", city: "St. Cloud, MN", published: true },
  { name: "Skyline Events Center", city: "Waite Park, MN", published: true },
  { name: "Depot Coffee House", city: "St. Cloud, MN", published: false },
] as const;
const REQUESTS = [
  { number: "Z-1041", subject: "Station offline or not working", state: "in progress" },
  { number: "Z-1038", subject: "Placement or relocation", state: "waiting for you" },
] as const;
const KIOSK_TONE = { online: "lime", offline: "red", maintenance: "gold", provisioning: "cyan", disabled: "mist" } as const;
const PAY_TONE = { paid: "lime", scheduled: "cyan", failed: "red" } as const;

const Card = ({ title, href, children }: { title: string; href?: string; children: React.ReactNode }) => (
  <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
    <div className="flex items-center justify-between">
      <h2 className="font-display text-lg font-bold">{title}</h2>
      {href && <Link href={href} className="text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Open →</Link>}
    </div>
    <div className="mt-4">{children}</div>
  </section>
);

export default function PartnerDemo() {
  const rentals30d = KIOSKS.reduce((a, k) => a + k.rentals, 0);
  const paidTotal = PAYOUTS.filter((p) => p.status === "paid").reduce((a, p) => a + p.amount, 0);
  const scheduled = PAYOUTS.filter((p) => p.status === "scheduled").reduce((a, p) => a + p.amount, 0);
  return (
    <PartnerGate title="Overview" nav="overview">
      {() => (
        <div className="space-y-6">
          <div className="rounded-xl bg-gold px-4 py-2.5 text-center text-xs font-extrabold uppercase tracking-widest text-ink">
            Sample data — portal preview · not your real numbers
          </div>

          <section aria-label="Your business" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Stations" value={KIOSKS.length} sub="3 online · 1 in maintenance" />
            <Metric label="Rentals (30 days)" value={rentals30d} sub="Across all stations" />
            <Metric label="Commission (June)" value={fmt(STATEMENTS.reduce((a, s) => a + s.commission, 0))} sub="Per-venue statements below" />
            <Metric label="Next payout" value={fmt(scheduled)} sub="Scheduled Jul 15" />
          </section>

          <section aria-label="Your stations" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Your stations</h2></div>
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                <tr>{["Station", "Venue", "Status", "Rentals (30d)", "Last seen"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {KIOSKS.map((k) => (
                  <tr key={k.id} className="border-b border-mist/70 last:border-0">
                    <td className="px-4 py-3 font-bold">{k.id}</td>
                    <td className="px-4 py-3 text-xs font-semibold">{k.venue}</td>
                    <td className="px-4 py-3"><Pill tone={KIOSK_TONE[k.state]}>{k.state}</Pill></td>
                    <td className="px-4 py-3 font-display font-bold">{k.rentals}</td>
                    <td className="px-4 py-3 text-xs text-graphite">{k.seen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Monthly statements — per venue" href="/partners/payouts">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-mist text-xs uppercase tracking-wider text-graphite"><tr>{["Venue", "Period", "Gross", "Your share"].map((h) => <th key={h} className="pb-2 pr-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {STATEMENTS.map((s) => (
                    <tr key={s.venue} className="border-b border-mist/70 last:border-0">
                      <td className="py-2.5 pr-3 text-xs font-semibold">{s.venue}</td>
                      <td className="py-2.5 pr-3 text-xs text-graphite">{s.period}</td>
                      <td className="py-2.5 pr-3 font-semibold">{fmt(s.gross)}</td>
                      <td className="py-2.5 font-display font-bold text-forest">{fmt(s.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card title="Payouts" href="/partners/payouts">
              <ul className="space-y-3 text-sm">
                {PAYOUTS.map((p) => (
                  <li key={p.period} className="flex items-center justify-between gap-3">
                    <span><b>{p.period}</b> <span className="text-graphite">· {p.venue}</span></span>
                    <span className="flex items-center gap-3">
                      <span className="font-display font-bold">{fmt(p.amount)}</span>
                      <Pill tone={PAY_TONE[p.status]}>{p.status === "paid" ? `paid ${p.paid}` : p.status}</Pill>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-graphite">Paid {fmt(paidTotal)} to date · statements arrive by email monthly, per location.</p>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Your venues">
              <ul className="space-y-3 text-sm">
                {VENUES.map((v) => (
                  <li key={v.name} className="flex items-center justify-between gap-3">
                    <span><b>{v.name}</b> <span className="text-graphite">· {v.city}</span></span>
                    <Pill tone={v.published ? "lime" : "mist"}>{v.published ? "live" : "pending"}</Pill>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Open requests" href="/partners/support">
              <ul className="space-y-2 text-sm">
                {REQUESTS.map((t) => (
                  <li key={t.number} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-mist/50">
                    <span className="truncate"><b>{t.number}</b> · {t.subject}</span>
                    <Pill tone={t.state === "waiting for you" ? "gold" : "cyan"}>{t.state}</Pill>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </PartnerGate>
  );
}
