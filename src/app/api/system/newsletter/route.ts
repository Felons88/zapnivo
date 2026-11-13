import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { serviceClient } from "@/lib/supabase";
import { getNewsletterOverview } from "@/lib/newsletter/service";

/**
 * GET /api/system/newsletter — subscriber stats + recent rows.
 * Perm: system.dashboard.view. Pending rows are reported separately and are
 * never included in the confirmed subscriber count.
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const db = serviceClient() ?? g.db;
  const overview = await getNewsletterOverview(db);
  if (!overview) return NextResponse.json({ error: "Newsletter data unavailable" }, { status: 503 });
  // Never expose token hashes to the client — staff only needs the lifecycle fields.
  const recent = overview.recent.map(({ confirm_token_hash, unsubscribe_token_hash, ...r }) => r);
  return NextResponse.json({ ...overview, recent });
}
