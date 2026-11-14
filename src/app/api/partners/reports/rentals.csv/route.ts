import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { toCsv } from "@/lib/partner-ops";
import { serviceClient } from "@/lib/supabase";

const YEAR_MS = 365 * 86400_000;

/**
 * Org-scoped partner report export: rentals for the caller's venues only,
 * trailing 12 months. Customer PII is deliberately not selected.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user || (user.role !== "partner" && !isStaff(user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const orgId = user.organizationId;
  if (!orgId) return NextResponse.json({ error: "No organization is linked to your account." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const { data: venueData } = await db.from("venues").select("id").eq("organization_id", orgId).limit(500);
  const venueIds = ((venueData ?? []) as { id: string }[]).map((v) => v.id);
  if (!venueIds.length) {
    return new NextResponse(toCsv([]), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="zapnivo-partner-rentals-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const since = new Date(Date.now() - YEAR_MS).toISOString();
  const { data, error } = await db
    .from("rentals")
    .select("reference,state,created_at,started_at,dispensed_at,returned_at,non_return_deadline,accrued_charge_cents,kiosks!inner(station_id,venues!inner(name))")
    .in("kiosks.venue_id", venueIds)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) return NextResponse.json({ error: "Export failed." }, { status: 500 });

  type Row = {
    reference: string; state: string; created_at: string;
    started_at: string | null; dispensed_at: string | null; returned_at: string | null; non_return_deadline: string | null;
    accrued_charge_cents: number | null;
    kiosks: { station_id: string; venues: { name: string } | { name: string }[] | null } | null;
  };
  const rows = ((data ?? []) as unknown as Row[]).map((r) => {
    const venue = Array.isArray(r.kiosks?.venues) ? r.kiosks?.venues[0] : r.kiosks?.venues;
    return {
      reference: r.reference,
      state: r.state,
      station_id: r.kiosks?.station_id ?? "",
      venue: venue?.name ?? "",
      created_at: r.created_at,
      started_at: r.started_at,
      dispensed_at: r.dispensed_at,
      returned_at: r.returned_at,
      non_return_deadline: r.non_return_deadline,
      accrued_charge_cents: r.accrued_charge_cents,
    };
  });

  await auditLog(user.id, "partner_export_csv", "partner_rentals", orgId, { organization_id: orgId, rows: rows.length, window_days: 365 });
  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="zapnivo-partner-rentals-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
