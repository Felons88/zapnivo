import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { systemSearch } from "@/lib/system/search";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/search?q= — federated technical-entity search.
 * Permission-aware: each entity group is only queried when the caller's
 * system role holds its permission (see src/lib/system/search.ts). No
 * customer PII is searched. Rate-limited 30/min per user.
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.dashboard.view", { limit: 30, windowMs: 60_000 });
  if (!g.ok) return g.res;

  const q = new URL(req.url).searchParams.get("q") ?? "";
  const result = await systemSearch(g.db, g.role, q);

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "search.query",
    resource: "system:search",
    detail: { q: result.q, groups: result.groups.map((gr) => ({ type: gr.type, count: gr.items.length })) },
  });

  return NextResponse.json(result);
}
