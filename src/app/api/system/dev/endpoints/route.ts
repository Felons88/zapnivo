import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { API_CATALOG, API_DOMAINS, PING_ALLOWLIST } from "@/lib/system/devtools";

/**
 * GET /api/system/dev/endpoints — static curated API catalog + the ping
 * allowlist. The catalog is hand-maintained (filesystem isn't reliably
 * available at runtime on serverless); descriptions are honest about auth.
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  return NextResponse.json({
    endpoints: API_CATALOG,
    domains: API_DOMAINS,
    pingAllowlist: PING_ALLOWLIST,
    note: "Catalog is hand-curated — verify against src/app/api before relying on it.",
  });
}
