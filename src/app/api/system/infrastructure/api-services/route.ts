import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { scanApiInventory, attachRouteErrors } from "@/app/system/infrastructure/api/inventory";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/infrastructure/api-services — route inventory for every
 * route.ts under src/app/api, classified by detected guard tokens (systemApiGuard
 * perms, CRON_SECRET, device auth, provider signatures, session helpers) with
 * an honest path-heuristic fallback. Read-only inventory — NOT uptime
 * monitoring. Error signal is attached from error_events where recorded.
 */
export async function GET() {
  const g = await systemApiGuard("system.integrations.view", { limit: 60 });
  if (!g.ok) return g.res;
  const inventory = scanApiInventory();
  await attachRouteErrors(g.db, inventory.routes);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "infrastructure.api_inventory_viewed",
    resource: "infrastructure:api",
    detail: { routes: inventory.routeCount },
  });
  return NextResponse.json({ inventory });
}
