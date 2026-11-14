import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { runExport } from "@/lib/admin-exports";
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

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const type = new URL(req.url).searchParams.get("type") ?? "";

  // Customer emails/names are deliberately not exported — operational columns only.
  // Catalogue lives in src/lib/admin-exports.ts (Phase 5 coverage).
  const result = await runExport(db, type);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  await auditLog(user!.id, "export_csv", "export", type, { rows: result.rows.length });
  return new NextResponse(toCsv(result.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="zapnivo-${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
