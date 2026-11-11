import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { staleReport } from "@/lib/knowledge/db";
import { serviceClient } from "@/lib/supabase";

/** Staff-only staleness report: published articles past their review-by dates. */
export async function GET() {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const articles = await staleReport(db);
  return NextResponse.json({ articles });
}
