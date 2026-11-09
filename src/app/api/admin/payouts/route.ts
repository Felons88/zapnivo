import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { generateLedgers } from "@/lib/ledgers";
import { serviceClient } from "@/lib/supabase";

const uuid = z.string().uuid();

/**
 * Finance actions. Ledger generation is staff; scheduling/marking payouts moves money records so it is admin-only.
 * Payouts are recorded manually (paid outside the app, e.g. ACH/check) — no automated transfer is claimed.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const back = (q = "") => NextResponse.redirect(new URL(`/admin/payouts${q}`, req.url), 303);

  if (action === "generate_ledgers") {
    const period = String(form.get("period") ?? "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return NextResponse.json({ error: "Period must be YYYY-MM." }, { status: 422 });
    const r = await generateLedgers(db, period);
    await auditLog(user!.id, "generate_ledgers", "ledger", null, { period, created: r.created.length, noRate: r.skippedNoRate.length, locked: r.skippedLocked.length });
    return back(`?gen=${r.created.length}&norate=${r.skippedNoRate.length}&locked=${r.skippedLocked.length}`);
  }

  if (user!.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });

  if (action === "schedule_payout") {
    const ledgerId = String(form.get("ledger_id") ?? "");
    if (!uuid.safeParse(ledgerId).success) return NextResponse.json({ error: "Invalid ledger." }, { status: 422 });
    const { data: ledger } = await db.from("commission_ledgers").select("id,commission_cents").eq("id", ledgerId).single();
    if (!ledger || ledger.commission_cents <= 0) return NextResponse.json({ error: "Nothing to pay on this ledger." }, { status: 400 });
    const { count } = await db.from("payout_records").select("id", { count: "exact", head: true }).eq("ledger_id", ledgerId);
    if ((count ?? 0) > 0) return NextResponse.json({ error: "A payout already exists for this ledger." }, { status: 409 });
    const { data, error } = await db.from("payout_records").insert({ ledger_id: ledgerId, amount_cents: ledger.commission_cents, status: "scheduled" }).select("id").single();
    if (error) return NextResponse.json({ error: "Couldn't schedule the payout." }, { status: 500 });
    await auditLog(user!.id, "schedule_payout", "ledger", ledgerId, { payout: data.id, cents: ledger.commission_cents });
    return back();
  }

  if (action === "mark_payout") {
    const id = String(form.get("payout_id") ?? "");
    const to = String(form.get("to") ?? "");
    if (!uuid.safeParse(id).success || !["paid", "failed"].includes(to)) return NextResponse.json({ error: "Invalid request." }, { status: 422 });
    const { data, error } = await db.from("payout_records").update({ status: to, paid_at: to === "paid" ? new Date().toISOString() : null }).eq("id", id).eq("status", "scheduled").select("id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "Only scheduled payouts can be updated." }, { status: 409 });
    await auditLog(user!.id, `payout_${to}`, "payment", id);
    return back();
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
