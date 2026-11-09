export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { Metric } from "@/components/AdminCards";
import { Pill } from "@/components/SupportNav";
import { fmt } from "@/lib/pricing";

export const metadata: Metadata = { title: "Dashboard preview", robots: { index: false, follow: false } };

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const I = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" aria-hidden className="h-[18px] w-[18px]" {...stroke}>{children}</svg>;
const icons = {
  station: <I><rect x="2" y="7" width="17" height="10" rx="2" /><path d="M22 11v2" /><path d="m11 9-2 3h3l-2 3" /></I>,
  rental: <I><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></I>,
  revenue: <I><circle cx="12" cy="12" r="9" /><path d="M15.5 9.5c-.8-.8-2-1.3-3.5-1.3-2 0-3.5 1-3.5 2.4 0 3.2 7 1.6 7 4.8 0 1.4-1.5 2.4-3.5 2.4-1.5 0-2.7-.5-3.5-1.3" /><path d="M12 6.5v1.7m0 7.6v1.7" /></I>,
  inbox: <I><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.5 2 12v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5l-3.5-6.5A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.5Z" /></I>,
};

const Card = ({ title, href, children }: { title: string; href?: string; children: ReactNode }) => (
  <section className="rounded-2xl border border-white/10 bg-[#181933] p-6 shadow-sm">
    <div className="flex items-center justify-between"><h2 className="font-display text-lg font-bold">{title}</h2>{href && <span className="text-xs font-extrabold uppercase tracking-wider text-lime">Open →</span>}</div>
    <div className="mt-4">{children}</div>
  </section>
);
const Row = ({ k, v }: { k: string; v: ReactNode }) => <div className="flex items-baseline justify-between gap-4"><dt className="text-sm text-silver">{k}</dt><dd className="font-display text-xl font-bold">{v}</dd></div>;

/* Sample data — preview only */
const ACTIVITY = [
  { n: "Z-1052", s: "Charger did not dispense", who: "Maya T. · customer", q: "support", t: "support", due: "due in 2h" },
  { n: "Z-1051", s: "Station offline or not working", who: "Northern Pour Bar · partner", q: "partner", t: "partner", due: "due in 4h" },
  { n: "Z-1049", s: "Billing question", who: "Devon R. · customer", q: "billing", t: "billing", due: "due tomorrow" },
  { n: "Z-1047", s: "Guest complaint at my venue", who: "Skyline Events · partner", q: "partner", t: "partner", due: "resolved" },
  { n: "Z-1044", s: "Hardware or safety issue", who: "Depot Coffee · partner", q: "safety", t: "safety", due: "overdue" },
] as const;
const VOLUME = [2, 4, 1, 5, 3, 6, 4, 7, 3, 2, 5, 8, 4, 3];
const peak = Math.max(...VOLUME);
const qTone = { support: "mist", billing: "gold", partner: "cyan", safety: "red" } as const;

export default function AdminDemo() {
  return (
    <AdminGate title="Dashboard" nav="dashboard">
      <div className="space-y-6">
        <div className="rounded-xl bg-gold px-4 py-2.5 text-center text-xs font-extrabold uppercase tracking-widest text-ink">
          Sample data — dashboard preview · <Link href="/admin" className="underline">back to live dashboard</Link>
        </div>

        <Link href="/admin/support" className="flex items-center gap-3 rounded-2xl border border-gold/40 bg-gold/15 px-5 py-3 text-sm font-bold text-ink hover:bg-gold/40">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-ink text-xs font-extrabold text-lime">!</span>
          <span>3 tickets unassigned</span><span aria-hidden>·</span><span>1 overdue first response</span>
          <span className="ml-auto text-xs font-extrabold uppercase tracking-wider">Open inbox →</span>
        </Link>

        <section aria-label="Business at a glance" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={icons.station} label="Stations online" value="4/6" sub="1 offline · 1 in maintenance" />
          <Metric icon={icons.rental} label="Active rentals" value="23" sub="12 new in last 24h · 1 unreturned" />
          <Metric icon={icons.revenue} label="Revenue captured" value={fmt(184250)} sub={`${fmt(3200)} refunded`} />
          <Metric icon={icons.inbox} label="Open tickets" value="9" sub="4 need a person · 3 unassigned" />
        </section>

        <section aria-label="Quick actions" className="flex flex-wrap gap-2">
          {["Register kiosk", "Invite a partner", "Queue statements", "Open inbox"].map((l) => (
            <span key={l} className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-extrabold uppercase tracking-wider text-white shadow-sm">{l}</span>
          ))}
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
          <div className="space-y-6">
            <Card title="Latest activity" href="/admin/support">
              <ul className="-mx-6 -mb-4 divide-y divide-white/10">
                {ACTIVITY.map((t) => (
                  <li key={t.n}><span className="flex items-center gap-4 px-6 py-3.5">
                    <span className="w-20 shrink-0 font-bold">{t.n}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{t.s}</span><span className="block truncate text-xs text-silver">{t.who}</span></span>
                    <span className="hidden sm:block"><Pill tone={qTone[t.q]}>{t.q}</Pill></span>
                    <span className="hidden text-xs text-silver md:block">{t.due}</span>
                  </span></li>
                ))}
              </ul>
            </Card>

            <Card title="Partner & maintenance requests" href="/admin/support?queue=partner">
              <ul className="-mx-6 -mb-4 divide-y divide-white/10">
                {[ACTIVITY[1], ACTIVITY[3], ACTIVITY[4]].map((t) => (
                  <li key={t.n}><span className="flex items-center gap-4 px-6 py-3.5">
                    <span className="w-20 shrink-0 font-bold">{t.n}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{t.s}</span><span className="block truncate text-xs text-silver">{t.who}</span></span>
                    <Pill tone={t.q === "safety" ? "red" : "cyan"}>{t.s}</Pill>
                  </span></li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="space-y-6">
            <Card title="Ticket volume · 14 days" href="/admin/support/metrics">
              <div className="flex h-24 items-end gap-1.5" role="img" aria-label="Sample ticket volume">
                {VOLUME.map((v, i) => <div key={i} className="flex flex-1 items-end"><span className="w-full rounded-t bg-violet/70" style={{ height: `${Math.max(4, (v / peak) * 100)}%` }} /></div>)}
              </div>
              <div className="mt-2 flex justify-between text-[10px] font-bold uppercase tracking-wider text-silver"><span>Jun 9</span><span>Jun 22</span></div>
            </Card>

            <Card title="Network" href="/admin/fleet">
              <dl className="space-y-3">
                <Row k="Venues live" v="5/6" />
                <Row k="Power banks in field" v="41" />
                <Row k="Slots ready / charging / fault" v="27 / 9 / 1" />
                <Row k="Maintenance visits logged" v="8" />
              </dl>
            </Card>

            <Card title="Intake" href="/admin/partners">
              <dl className="space-y-3">
                <Row k="Partner applications" v="3 new · 14 total" />
                <Row k="Advertising inquiries" v="2 new · 6 total" />
                <Row k="Unhandled contact messages" v="4" />
              </dl>
            </Card>

            <Card title="Response" href="/admin/support/metrics">
              <dl className="space-y-3">
                <Row k="Avg first response" v="1.8h" />
                <Row k="Resolved" v="57" />
                <Row k="Resolved by AI alone" v="21 (36%)" />
              </dl>
            </Card>
          </div>
        </div>
      </div>
    </AdminGate>
  );
}
