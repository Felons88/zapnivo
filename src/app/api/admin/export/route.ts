import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

/** Neutralizes spreadsheet formula injection and quotes per RFC 4180. */
const cell = (v: unknown) => {
  let s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const toCsv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return "no_rows\n";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
};

const EXPORTS: Record<string, { table: string; select: string; order: string }> = {
  rentals: { table: "rentals", select: "reference,state,started_at,dispensed_at,returned_at,non_return_deadline,created_at", order: "created_at" },
  payments: { table: "payments", select: "state,amount_authorized_cents,amount_captured_cents,currency,captured_at,created_at", order: "created_at" },
  payouts: { table: "payout_records", select: "amount_cents,status,paid_at,created_at", order: "created_at" },
  ledgers: { table: "commission_ledgers", select: "period,gross_cents,commission_cents,created_at", order: "period" },
  tickets: { table: "support_tickets", select: "ticket_number,category,state,priority,created_at,resolved_at", order: "created_at" },
  kiosks: { table: "kiosks", select: "station_id,state,model,firmware_version,last_seen_at,installed_at,slot_count", order: "created_at" },
};

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const type = new URL(req.url).searchParams.get("type") ?? "";
  const def = EXPORTS[type];
  if (!def) return NextResponse.json({ error: `type must be one of: ${Object.keys(EXPORTS).join(", ")}` }, { status: 400 });

  // Customer emails/names are deliberately not exported — operational columns only.
  const { data, error } = await db.from(def.table).select(def.select).order(def.order, { ascending: false }).limit(10000);
  if (error) return NextResponse.json({ error: "Export failed." }, { status: 500 });
  await auditLog(user!.id, "export_csv", "export", type, { rows: data?.length ?? 0 });
  return new NextResponse(toCsv((data ?? []) as unknown as Record<string, unknown>[]), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="zapnivo-${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
