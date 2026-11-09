import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { flushOutbox } from "@/lib/helpdesk/mailer";
import { getRepo } from "@/lib/helpdesk/repo";
import { fmt } from "@/lib/pricing";
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
    .select("period,gross_cents,commission_cents,venues!inner(id,name,city,organization_id)")
    .eq("period", periodStart)
    .limit(500);
  const rows = (ledgers ?? []) as unknown as { period: string; gross_cents: number; commission_cents: number; venues: { id: string; name: string; city: string; organization_id: string | null }[] | null }[];
  if (!rows.length) return NextResponse.redirect(new URL(`/admin/partners?stm=none`, req.url), 303);

  let queued = 0;
  const month = new Date(`${periodStart}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  for (const l of rows) {
    const venue = l.venues?.[0];
    if (!venue?.organization_id) continue;
    const { data: owners } = await db.from("profiles").select("email,full_name").eq("organization_id", venue.organization_id).eq("role", "partner").limit(20);
    for (const o of (owners ?? []) as { email: string; full_name: string | null }[]) {
      await repo.queueEmail({
        html: null,
        ticketId: null,
        to: o.email,
        subject: `Your ${month} statement — ${venue.name}`,
        body: `Hi${o.full_name ? ` ${o.full_name.split(" ")[0]}` : ""},\n\nYour monthly Zapnivo statement for ${venue.name} (${venue.city}) is ready.\n\n  Period:      ${month}\n  Gross:       ${fmt(l.gross_cents)}\n  Commission:  ${fmt(l.commission_cents)}\n\nView your statements and payout status any time at https://partners.zapnivo.com/payouts\n\nZapnivo Partner Relations`,
      });
      queued++;
    }
  }
  await flushOutbox(repo, null).catch(() => null);
  return NextResponse.redirect(new URL(`/admin/partners?stm=${queued}`, req.url), 303);
}
