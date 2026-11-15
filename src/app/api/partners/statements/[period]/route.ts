import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { getSessionUser } from "@/lib/auth";
import { computePartnerEarnings, statementCsv } from "@/lib/settlement";
import { serviceClient } from "@/lib/supabase";

/** Months between YYYY-MM `period` and `now` (inclusive window size for the earnings query). */
const monthsCovering = (period: string, now = new Date()) => {
  const [y, m] = period.split("-").map(Number);
  return Math.max(1, (now.getUTCFullYear() * 12 + now.getUTCMonth()) - (y * 12 + (m - 1)) + 1);
};

/**
 * Org-scoped monthly commission statement CSV for the partner portal.
 * Partner role + linked organization required; every query inside
 * computePartnerEarnings is scoped through venues.organization_id.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ period: string }> }) {
  const user = await getSessionUser();
  if (!user || user.role !== "partner" || !user.organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { period } = await params;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return NextResponse.json({ error: "Period must be YYYY-MM." }, { status: 422 });
  }
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const rows = (await computePartnerEarnings(db, user.organizationId, monthsCovering(period))).filter((r) => r.period === period);
  await auditLog(user.id, "partner_statement_export", "partner_statement", user.organizationId, { organization_id: user.organizationId, period, rows: rows.length });

  return new NextResponse(statementCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="zapnivo-statement-${period}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
