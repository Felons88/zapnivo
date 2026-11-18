export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getAdminStats, pick, total } from "@/lib/admin-stats";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { defaultCtx } from "@/lib/helpdesk/service";
import { humanDue } from "@/lib/helpdesk/sla";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";
import { loadWalletStats } from "@/lib/wallet-admin";
import { unreconciledPaymentIds, payoutBacklogHit, UNRECONCILED_CAPTURED_HOURS } from "@/lib/system/alert-sweep";

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
    <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">{title}</h2>
        {href && <Link href={href} className="text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Open →</Link>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Row = ({ k, v }: { k: string; v: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4"><dt className="text-sm text-graphite">{k}</dt><dd className="font-display text-xl font-bold">{v}</dd></div>
);

/** Area/line chart — server-rendered SVG, no JS. */
function AreaChart({ data, color = "#8063ff", label }: { data: number[]; color?: string; label: string }) {
  const w = 560, h = 96, p = 6, gid = `a${color.slice(1)}`;
  const max = Math.max(1, ...data);
  const step = (w - 2 * p) / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => `${(p + i * step).toFixed(1)},${(h - p - (v / max) * (h - 2 * p)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-24 w-full" role="img" aria-label={label} preserveAspectRatio="none">
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".3" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <polygon points={`${p},${h - p} ${pts} ${w - p},${h - p}`} fill={`url(#${gid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Donut chart with legend — server-rendered SVG. */
function Donut({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const R = 15.9, C = 2 * Math.PI * R;
  const sum = Math.max(1, parts.reduce((a, p) => a + p.value, 0));
  let off = 0;
  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 42 42" className="h-28 w-28 shrink-0 -rotate-90" role="img" aria-label={`Ticket mix: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
        <circle cx="21" cy="21" r={R} fill="none" stroke="#eae7fa" strokeWidth="7" />
        {parts.map((p) => { const f = p.value / sum; const el = <circle key={p.label} cx="21" cy="21" r={R} fill="none" stroke={p.color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${f * C} ${C}`} strokeDashoffset={-off * C} />; off += f; return el; })}
      </svg>
      <ul className="space-y-1.5 text-xs font-bold">
        {parts.map((p) => <li key={p.label} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} aria-hidden /><span className="capitalize">{p.label}</span><span className="text-graphite">· {p.value}</span></li>)}
      </ul>
    </div>
  );
}

const QUICK_ACTIONS = [
  { href: "/admin/customers", label: "Find a customer" },
  { href: "/admin/fleet#register-kiosk", label: "Register kiosk" },
  { href: "/admin/partners#invite-partner", label: "Invite a partner" },
  { href: "/admin/partners#statements", label: "Queue statements" },
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

  // 30-day rentals trend + ticket queue mix — real rows
  const start30 = new Date(now); start30.setHours(0, 0, 0, 0); start30.setDate(start30.getDate() - 29);
  const rentalSeries = Array(30).fill(0) as number[];
  const db = serviceClient();
  if (db) {
    const { data } = await db.from("rentals").select("created_at").gte("created_at", start30.toISOString()).limit(5000);
    for (const r of (data ?? []) as { created_at: string }[]) {
      const c = new Date(r.created_at); c.setHours(0, 0, 0, 0);
      const idx = Math.round((c.getTime() - start30.getTime()) / 86400_000);
      if (idx >= 0 && idx < 30) rentalSeries[idx]++;
    }
  }
  const cronRes = db ? await db.from("cron_runs").select("job,ok,ran_at,detail").order("ran_at", { ascending: false }).limit(6) : null;
  const crons = (cronRes?.data ?? []) as { job: string; ok: boolean; ran_at: string; detail: unknown }[];
  const walletStats = db ? await loadWalletStats(db) : null;
  const queues = { support: 0, billing: 0, partner: 0, safety: 0 };
  for (const t of all) if (t.queue in queues) queues[t.queue as keyof typeof queues]++;

  const kiosksOnline = pick(stats?.kioskStates, "online");
  const kiosksTotal = total(stats?.kioskStates);
  const rentalsActive = pick(stats?.rentalStates, "active") + pick(stats?.rentalStates, "dispense_pending");
  const attention = (m?.overdueFirstResponse ?? 0) + (m?.unassigned ?? 0);

  /* ── Executive snapshot (Phase 6) ────────────────────────────────────────
     Live DB-derived business metrics for the exec view. Every figure is a
     real row count/sum — a failed query degrades THAT metric to
     "unavailable" (never a fabricated number, never a page crash). No
     client JS; all server-rendered. revenue-assurance.ts does not exist
     yet, so the reconciliation count is computed inline with the same
     rule the alert sweep uses (captured >48h on a pre-completion rental). */
  type ExecItem = { label: string; value: string; sub: string; href: string; live: boolean };
  const execItems: ExecItem[] = [];
  const execSafe = async <T,>(fn: () => Promise<T | null>): Promise<T | null> => {
    try { return await fn(); } catch { return null; }
  };
  const unavailable = (label: string, href: string, sub = "Query failed — metric unavailable"): ExecItem =>
    ({ label, value: "—", sub, href, live: false });

  if (db) {
    // Revenue captured — net (captured − refunded, floored per payment) for
    // the last 30d vs the prior 30d. "live": straight payments rows.
    const prior30 = new Date(start30.getTime() - 30 * 86400_000);
    const payRows = await execSafe(async () => {
      const { data, error } = await db.from("payments")
        .select("captured_at,amount_captured_cents,amount_refunded_cents")
        .gte("captured_at", prior30.toISOString())
        .limit(20000);
      return error ? null : ((data ?? []) as { captured_at: string | null; amount_captured_cents: number | null; amount_refunded_cents: number | null }[]);
    });
    if (payRows == null) {
      execItems.push(unavailable("Revenue captured · 30d", "/admin/finance"));
    } else {
      let cur = 0, prev = 0;
      for (const p of payRows) {
        const net = Math.max(0, (p.amount_captured_cents ?? 0) - (p.amount_refunded_cents ?? 0));
        if (!p.captured_at) continue;
        if (p.captured_at >= start30.toISOString()) cur += net; else prev += net;
      }
      const delta = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
      execItems.push({
        label: "Revenue captured · 30d",
        value: fmt(cur),
        sub: delta == null ? `prior 30d ${fmt(prev)} — no baseline` : `${delta >= 0 ? "+" : ""}${delta}% vs prior 30d (${fmt(prev)})`,
        href: "/admin/finance",
        live: true,
      });
    }

    // Rentals started (created) in the last 30d — head count, live.
    const rentals30 = await execSafe(async () => {
      const { count, error } = await db.from("rentals")
        .select("id", { count: "exact", head: true })
        .gte("created_at", start30.toISOString());
      return error ? null : count;
    });
    execItems.push(rentals30 == null
      ? unavailable("Rentals started · 30d", "/admin/rentals")
      : { label: "Rentals started · 30d", value: String(rentals30), sub: "created_at window — live count", href: "/admin/rentals", live: true });

    // Open rental exceptions — status not in resolved/dismissed (same rule
    // as admin-insights openExceptions). Bounded status scan.
    const exceptionRows = await execSafe(async () => {
      const { data, error } = await db.from("rental_exceptions").select("status").limit(5000);
      return error ? null : ((data ?? []) as { status: string | null }[]);
    });
    const openExceptions = exceptionRows == null ? null
      : exceptionRows.filter((e) => !["resolved", "dismissed"].includes(e.status ?? "")).length;
    execItems.push(openExceptions == null
      ? unavailable("Open exceptions", "/admin/rentals")
      : { label: "Open exceptions", value: String(openExceptions), sub: "rental_exceptions not resolved/dismissed — live", href: "/admin/rentals", live: true });

    // Payout backlog — same aging rule as the finance.payout_backlog probe:
    // approved >7d (approved_at, created_at fallback) or scheduled >14d.
    const payoutRows = await execSafe(async () => {
      const { data, error } = await db.from("payout_records")
        .select("id,status,created_at,approved_at")
        .in("status", ["scheduled", "approved"])
        .limit(500);
      return error ? null : ((data ?? []) as { id: string; status: string | null; created_at: string | null; approved_at: string | null }[]);
    });
    const backlog = payoutRows == null ? null
      : payoutRows.filter((p) => payoutBacklogHit(p.status ?? "", p.approved_at, p.created_at, now.getTime())).length;
    execItems.push(backlog == null
      ? unavailable("Payout backlog", "/admin/payouts")
      : { label: "Payout backlog", value: String(backlog), sub: "approved >7d or scheduled >14d — live", href: "/admin/payouts", live: true });

    // Reconciliation exceptions — src/lib/revenue-assurance.ts does not exist
    // yet, so this is the same approximation the alert sweep uses: payments
    // captured >48h ago whose rental is still pre-completion (or orphaned).
    // Labelled as an approximation, not ledger truth.
    const reconCount = await execSafe(async () => {
      const cutoff = new Date(now.getTime() - UNRECONCILED_CAPTURED_HOURS * 3_600_000).toISOString();
      const { data: pays, error } = await db.from("payments")
        .select("id,rental_id")
        .gt("amount_captured_cents", 0)
        .lt("captured_at", cutoff)
        .limit(500);
      if (error) return null;
      const rows = (pays ?? []) as { id: string; rental_id: string | null }[];
      const rentalIds = [...new Set(rows.map((p) => p.rental_id).filter((r): r is string => !!r))];
      const states = new Map<string, string | null>();
      for (let i = 0; i < rentalIds.length; i += 200) {
        const { data: rs, error: rErr } = await db.from("rentals").select("id,state").in("id", rentalIds.slice(i, i + 200)).limit(200);
        if (rErr) return null;
        for (const r of (rs ?? []) as { id: string; state: string | null }[]) states.set(r.id, r.state);
      }
      return unreconciledPaymentIds(rows, states).length;
    });
    execItems.push(reconCount == null
      ? unavailable("Reconciliation exceptions", "/admin/finance", "Approximation unavailable — payments/rentals query failed")
      : { label: "Reconciliation exceptions", value: String(reconCount), sub: `captured >${UNRECONCILED_CAPTURED_HOURS}h on unfinished rentals — approx.`, href: "/admin/finance", live: true });

    // Forecast pointer — link tile to the forecasting model.
    execItems.push({ label: "Revenue forecast", value: "Open →", sub: "Scenario model & assumptions", href: "/admin/forecasting", live: true });
  } else {
    for (const [label, href] of [
      ["Revenue captured · 30d", "/admin/finance"],
      ["Rentals started · 30d", "/admin/rentals"],
      ["Open exceptions", "/admin/rentals"],
      ["Payout backlog", "/admin/payouts"],
      ["Reconciliation exceptions", "/admin/finance"],
      ["Revenue forecast", "/admin/forecasting"],
    ] as const) execItems.push(unavailable(label, href, "Database not configured"));
  }

  const workItems = [
    ...(m ? [
      { label: "Unassigned tickets", count: m.unassigned, href: "/admin/support?view=unassigned", area: "Customer care" },
      { label: "Overdue first responses", count: m.overdueFirstResponse, href: "/admin/support?view=person", area: "Customer care" },
    ] : []),
    ...(stats ? [
      { label: "Offline stations", count: pick(stats.kioskStates, "offline"), href: "/admin/fleet", area: "Network" },
      { label: "New partner applications", count: pick(stats.applicationStates, "new"), href: "/admin/partners", area: "Partners" },
      { label: "Unhandled inquiries", count: stats.unhandledContacts ?? 0, href: "/admin/inquiries", area: "Customer care" },
    ] : []),
    ...execItems.filter((item) => item.live && ["Open exceptions", "Payout backlog"].includes(item.label) && Number(item.value) > 0)
      .map((item) => ({ label: item.label, count: Number(item.value), href: item.href, area: item.label === "Payout backlog" ? "Finance" : "Network" })),
  ].filter((item) => item.count > 0);

  return (
    <AdminGate title="Dashboard" nav="dashboard">
      <div className="space-y-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-forest">Internal workspace</p>
            <h2 className="mt-2 font-display text-3xl font-bold tracking-tight md:text-4xl">Your day at a glance</h2>
            <p className="mt-2 text-sm text-graphite">Start with what needs a person, then jump into a Zapnivo program.</p>
          </div>
          <Link href="/admin/support" className="rounded-lg bg-ink px-4 py-2.5 text-sm font-bold text-white hover:bg-forest">Open inbox →</Link>
        </div>

        <section aria-label="Customer lookup" className="rounded-2xl border border-mist bg-white p-4 shadow-sm">
          <form method="get" action="/admin/customers" className="flex flex-col gap-3 sm:flex-row">
            <label htmlFor="dash-crm" className="sr-only">Customer lookup</label>
            <input id="dash-crm" name="q" required minLength={2} placeholder="Find a customer by name, phone, email or rental ref" className="min-h-11 flex-1 rounded-lg border border-silver/70 px-4 text-sm" />
            <button className="min-h-11 rounded-lg bg-forest px-6 text-sm font-bold text-white hover:bg-ink">Search</button>
          </form>
        </section>
        {attention > 0 && (
          <Link href="/admin/support" className="flex items-center gap-3 rounded-2xl border border-gold/60 bg-gold/25 px-5 py-3 text-sm font-bold text-ink hover:bg-gold/40">
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

        <section aria-label="Prepaid wallet" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div><p className="eyebrow text-forest">Stored-value wallet</p><h2 className="mt-1 font-display text-lg font-bold">Prepaid card &amp; top-ups</h2></div>
            <p className="text-xs text-graphite">{walletStats?.lastPaidAt ? `Last Stripe-confirmed top-up ${new Date(walletStats.lastPaidAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" })}` : "No confirmed top-ups yet"}</p>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Loaded today" value={walletStats ? fmt(walletStats.loadedTodayCents) : "—"} sub={walletStats ? `${fmt(walletStats.loaded30dCents)} in 30 days · ${walletStats.paidTopups30d} top-ups` : "Wallet data unavailable"} />
            <Metric label="Outstanding credit" value={walletStats ? fmt(walletStats.outstandingCents) : "—"} sub="Unspent stored value across customers" />
            <Metric label="Active prepaid cards" value={walletStats ? walletStats.activeCards : "—"} sub="Zapnivo machines only" />
            <Metric label="Top-up exceptions" value={walletStats ? walletStats.failedTopups30d + walletStats.pendingTopups : "—"} sub={walletStats ? `${walletStats.failedTopups30d} failed · ${walletStats.pendingTopups} awaiting webhook (30d)` : undefined} />
          </div>
        </section>

        <section aria-labelledby="work-heading" className="overflow-hidden rounded-2xl border border-mist bg-white shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-mist px-5 py-4">
            <div><p className="eyebrow text-silver">Daily brief</p><h3 id="work-heading" className="mt-1 font-display text-xl font-bold">Needs attention</h3></div>
            <span className="text-xs font-semibold text-graphite">From connected systems</span>
          </div>
          {workItems.length === 0 ? <p className="px-5 py-6 text-sm text-graphite">No action items surfaced from connected systems.</p> :
            <ul className="grid gap-px bg-mist md:grid-cols-2 xl:grid-cols-3">{workItems.map((item) => <li key={item.label} className="bg-white">
              <Link href={item.href} className="flex items-center gap-4 px-5 py-4 hover:bg-lime/10">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gold/30 font-display text-xl font-bold">{item.count}</span>
                <span className="min-w-0 flex-1"><span className="block text-sm font-bold">{item.label}</span><span className="block text-xs text-graphite">{item.area}</span></span><span aria-hidden className="text-forest">↗</span>
              </Link>
            </li>)}</ul>}
        </section>

        <section aria-labelledby="programs-heading">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div><p className="eyebrow text-silver">Explore</p><h3 id="programs-heading" className="font-display text-xl font-bold">Your programs</h3></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { title: "Customer care", detail: m ? `${m.open} open tickets` : "Inbox, customers and requests", href: "/admin/support", links: ["Inbox", "Customers", "Refunds"] },
              { title: "Network operations", detail: kiosksTotal == null ? "Fleet, rentals and restocking" : `${kiosksOnline} of ${kiosksTotal} stations online`, href: "/admin/fleet", links: ["Fleet", "Rentals", "Restocking"] },
              { title: "Partners", detail: "Venues, onboarding and placements", href: "/admin/partners", links: ["Partners", "Placements", "Agreements"] },
              { title: "Commerce", detail: "Memberships, gifts and events", href: "/admin/memberships", links: ["Memberships", "Gifts", "Events"] },
              { title: "Growth", detail: "Campaigns, opportunities and insights", href: "/admin/opportunities", links: ["Opportunities", "Advertising", "Analytics"] },
              { title: "Finance", detail: "Revenue, payouts and investigations", href: "/admin/finance", links: ["Revenue", "Payouts", "Forecasting"] },
            ].map((program) => (
              <Link key={program.title} href={program.href} className="group flex min-h-36 flex-col justify-between rounded-2xl border border-mist bg-white p-5 shadow-sm transition-colors hover:border-forest/40 hover:bg-lime/15">
                <span className="flex items-start justify-between gap-2 font-display text-lg font-bold">{program.title}<span aria-hidden className="text-forest transition-transform group-hover:translate-x-1">↗</span></span>
                <span><span className="block text-sm text-graphite">{program.detail}</span><span className="mt-3 block text-[11px] font-bold text-forest">{program.links.join(" · ")}</span></span>
              </Link>
            ))}
          </div>
        </section>

        <Card title="Recent requests" href="/admin/support">
          {recent.length === 0 ? <p className="text-sm text-graphite">No support requests yet.</p> : (
            <ul className="divide-y divide-mist">
              {recent.slice(0, 4).map((t) => <li key={t.id}>
                <Link href={`/admin/support/${t.number}`} className="flex items-center gap-3 py-3 text-sm hover:text-forest">
                  <span className="w-20 shrink-0 font-bold">{t.number}</span><span className="min-w-0 flex-1 truncate">{t.subject}</span>
                  <span className="hidden text-xs text-graphite sm:block">{t.queue}</span><span aria-hidden>↗</span>
                </Link>
              </li>)}
            </ul>
          )}
        </Card>

        <details className="group rounded-2xl border border-mist bg-white p-5 shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
            <span><span className="block font-display text-lg font-bold">Reports and tools</span><span className="mt-1 block text-sm text-graphite">Trends, finance checks, exports and deeper operations data</span></span>
            <span aria-hidden className="text-2xl text-forest transition-transform group-open:rotate-90">›</span>
          </summary>
          <div className="mt-6 space-y-6 border-t border-mist pt-6">
        <Card title="Executive snapshot" href="/admin/finance">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {execItems.map((item) => (
              <Link key={item.label} href={item.href} className="group rounded-xl border border-mist bg-mist/20 p-4 transition-colors hover:border-forest/40 hover:bg-mist/40">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-silver">{item.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider ${item.live ? "bg-forest/10 text-forest" : "bg-gold/30 text-ink"}`}>{item.live ? "live" : "unavailable"}</span>
                </div>
                <div className="mt-1.5 font-display text-2xl font-bold">{item.value}</div>
                <div className="mt-0.5 text-xs text-graphite">{item.sub}</div>
              </Link>
            ))}
          </div>
        </Card>

        <section aria-label="Quick actions" className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((a, i) => (
            <Link key={`${a.href}-${i}`} href={a.href} className="rounded-full border border-silver/50 bg-white px-4 py-2 text-xs font-extrabold uppercase tracking-wider text-ink shadow-sm transition-colors hover:border-ink hover:bg-lime">
              {a.label}
            </Link>
          ))}
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
          <div className="space-y-6">
            <Card title="Rentals · 30 days" href="/admin/rentals">
              <AreaChart data={rentalSeries} label="New rentals per day over the last 30 days" />
              <div className="mt-2 flex justify-between text-[10px] font-bold uppercase tracking-wider text-silver">
                <span>{start30.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                <span>{rentalSeries.reduce((a, b) => a + b, 0)} total</span>
                <span>Today</span>
              </div>
            </Card>

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
            <Card title="Ticket mix" href="/admin/support">
              <Donut parts={[
                { label: "support", value: queues.support, color: "#8063ff" },
                { label: "billing", value: queues.billing, color: "#ffdc8d" },
                { label: "partner", value: queues.partner, color: "#74e7ed" },
                { label: "safety", value: queues.safety, color: "#ff86b5" },
              ]} />
            </Card>

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

            <Card title="System">
              <ul className="space-y-1.5 text-xs">
                {crons.length === 0 ? <li className="text-graphite">No scheduled runs recorded yet — the daily sweep logs here.</li> : crons.slice(0, 3).map((c, i) => (
                  <li key={i} className="flex items-center justify-between"><span className="font-bold capitalize">{c.job} sweep</span><span className={c.ok ? "text-forest" : "font-bold text-red-700"}>{c.ok ? "ok" : "FAILED"} · {new Date(c.ran_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></li>
                ))}
              </ul>
              <p className="mt-4 text-[10px] font-extrabold uppercase tracking-widest text-silver">Export CSV</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {["rentals", "payments", "payouts", "ledgers", "tickets", "kiosks"].map((t) => <a key={t} href={`/api/admin/export?type=${t}`} className="rounded-full border border-silver/50 px-3 py-1 text-xs font-bold capitalize hover:border-ink">{t}</a>)}
              </div>
              <a href="/api/cron/rentals" className="mt-4 inline-block text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Run checks now →</a>
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
        </details>
      </div>
    </AdminGate>
  );
}
