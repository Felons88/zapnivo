import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { triggerRevenueStatement } from "@/lib/email-extra-triggers";
import { flushOutbox } from "@/lib/helpdesk/mailer";
import { getRepo } from "@/lib/helpdesk/repo";
import { serviceClient } from "@/lib/supabase";

/**
 * Queues monthly commission statements: one email per venue, to every partner
 * account on the owning organization. Goes through the helpdesk outbox so
 * nothing is claimed sent when the mailer isn't configured.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  const repo = await getRepo();
  if (!db || !repo) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const form = await req.formData();
  const period = String(form.get("period") ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return NextResponse.json({ error: "Period must be YYYY-MM." }, { status: 422 });
  const periodStart = `${period}-01`;

  const { data: ledgers } = await db
    .from("commission_ledgers")
    .select("id,gross_cents,commission_cents,venues!inner(id,name,city,organization_id)")
    .eq("period", periodStart)
    .limit(500);
  const rows = (ledgers ?? []) as unknown as { id: string; gross_cents: number; commission_cents: number; venues: { id: string; name: string; city: string; organization_id: string | null } | null }[];
  if (!rows.length) return NextResponse.redirect(new URL(`/admin/partners?stm=none`, req.url), 303);

  // Roll venue ledgers up to one statement per partner organization.
  type OrgAgg = { gross: number; share: number; ledgerIds: string[]; venueIds: string[]; venueNames: string[] };
  const byOrg = new Map<string, OrgAgg>();
  for (const l of rows) {
    const v = l.venues;
    if (!v?.organization_id) continue;
    const a = byOrg.get(v.organization_id) ?? { gross: 0, share: 0, ledgerIds: [], venueIds: [], venueNames: [] };
    a.gross += l.gross_cents; a.share += l.commission_cents;
    a.ledgerIds.push(l.id); a.venueIds.push(v.id); a.venueNames.push(v.name);
    byOrg.set(v.organization_id, a);
  }
  if (!byOrg.size) return NextResponse.redirect(new URL(`/admin/partners?stm=none`, req.url), 303);

  const orgIds = [...byOrg.keys()];
  const allVenueIds = [...new Set(rows.map((l) => l.venues?.id).filter((x): x is string => !!x))];
  const allLedgerIds = rows.map((l) => l.id);
  const nextMonth = new Date(`${periodStart}T00:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const [{ data: orgs }, { data: pays }, { data: payouts }, { data: owners }] = await Promise.all([
    db.from("organizations").select("id,name").in("id", orgIds),
    db.from("payments").select("amount_captured_cents,amount_refunded_cents,rentals!inner(kiosks!inner(venue_id))")
      .in("rentals.kiosks.venue_id", allVenueIds).gte("captured_at", periodStart).lt("captured_at", nextMonth.toISOString()).limit(20000),
    db.from("payout_records").select("ledger_id,status,paid_at,created_at").in("ledger_id", allLedgerIds).limit(2000),
    db.from("profiles").select("email,organization_id").in("organization_id", orgIds).eq("role", "partner").limit(200),
  ]);

  const orgName = new Map(((orgs ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
  const venueOrg = new Map(rows.filter((l) => l.venues?.id).map((l) => [l.venues!.id, l.venues!.organization_id!]));
  const payAgg = new Map<string, { captured: number; refunded: number; count: number }>();
  for (const p of (pays ?? []) as unknown as { amount_captured_cents: number | null; amount_refunded_cents: number | null; rentals: { kiosks: { venue_id: string } | { venue_id: string }[] | null } | null }[]) {
    const k = p.rentals?.kiosks; const vid = Array.isArray(k) ? k[0]?.venue_id : k?.venue_id;
    const oid = vid ? venueOrg.get(vid) : null;
    if (!oid) continue;
    const a = payAgg.get(oid) ?? { captured: 0, refunded: 0, count: 0 };
    a.captured += p.amount_captured_cents ?? 0; a.refunded += p.amount_refunded_cents ?? 0; a.count++;
    payAgg.set(oid, a);
  }
  const payByLedger = new Map<string, { status: string; when: string }[]>();
  for (const r of (payouts ?? []) as { ledger_id: string; status: string; paid_at: string | null; created_at: string }[]) {
    const list = payByLedger.get(r.ledger_id) ?? []; list.push({ status: r.status, when: r.paid_at ?? r.created_at }); payByLedger.set(r.ledger_id, list);
  }
  const ownersByOrg = new Map<string, string[]>();
  for (const o of (owners ?? []) as { email: string; organization_id: string }[]) {
    const list = ownersByOrg.get(o.organization_id) ?? []; list.push(o.email); ownersByOrg.set(o.organization_id, list);
  }

  const month = new Date(`${periodStart}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  let queued = 0;
  for (const [orgId, a] of byOrg) {
    const ledgerPayouts = a.ledgerIds.flatMap((id) => payByLedger.get(id) ?? []);
    const payoutStatus = ledgerPayouts.some((p) => p.status === "failed") ? "Failed — needs review"
      : ledgerPayouts.length && ledgerPayouts.every((p) => p.status === "paid") ? "Paid"
      : ledgerPayouts.length ? "Scheduled" : "Not yet scheduled";
    const lastPayout = ledgerPayouts.map((p) => p.when).sort().at(-1);
    const pa = payAgg.get(orgId) ?? { captured: 0, refunded: 0, count: 0 };
    const vars = {
      orgName: orgName.get(orgId) ?? a.venueNames[0] ?? "your organization",
      period: month,
      rentalsCount: String(pa.count),
      grossAmount: money(pa.captured),
      refundsAmount: money(pa.refunded),
      revenueShare: money(a.share),
      netAmount: money(a.share),
      payoutStatus,
      payoutDate: lastPayout ? day(lastPayout) : "",
    };
    for (const email of ownersByOrg.get(orgId) ?? []) {
      await triggerRevenueStatement(email, vars).catch(() => false);
      queued++;
    }
  }
  await flushOutbox(repo, null).catch(() => null);
  return NextResponse.redirect(new URL(`/admin/partners?stm=${queued}`, req.url), 303);
}
