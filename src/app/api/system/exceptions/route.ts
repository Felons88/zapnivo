import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { isUuid, listExceptions } from "@/lib/system/exceptions";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/exceptions?state=&kind=&kiosk=&rental=&assigned=&older_than_hours=
 *
 * Rental exception list (rental_exceptions, migration 0050/0054). Read perm:
 * system.kiosks.view — exceptions are kiosk-fleet operational data.
 * `assigned` accepts a profile uuid, "me", or "unassigned". `state` accepts a
 * canonical state, "active" (not resolved/dismissed), "all", or legacy "open".
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;

  const sp = new URL(req.url).searchParams;
  const state = sp.get("state") ?? undefined;
  const kind = sp.get("kind") ?? undefined;
  const kiosk = sp.get("kiosk") ?? undefined;
  const rental = sp.get("rental") ?? undefined;
  const assignedRaw = sp.get("assigned") ?? undefined;
  const ageRaw = sp.get("older_than_hours") ?? undefined;
  const limitRaw = sp.get("limit") ?? undefined;

  let assignedTo: string | undefined;
  if (assignedRaw === "me") assignedTo = g.user.id;
  else if (assignedRaw === "unassigned") assignedTo = "unassigned";
  else if (assignedRaw) {
    if (!isUuid(assignedRaw)) return NextResponse.json({ error: "Invalid assigned filter — expected a profile uuid, 'me', or 'unassigned'" }, { status: 400 });
    assignedTo = assignedRaw;
  }
  const olderThanHours = ageRaw ? Number(ageRaw) : undefined;
  if (olderThanHours !== undefined && (!Number.isFinite(olderThanHours) || olderThanHours <= 0 || olderThanHours > 24 * 365)) {
    return NextResponse.json({ error: "Invalid older_than_hours" }, { status: 400 });
  }
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
  }

  const { configured, rows, error } = await listExceptions(g.db, {
    state, kind,
    kioskId: kiosk && isUuid(kiosk) ? kiosk : undefined,
    rentalId: rental && isUuid(rental) ? rental : undefined,
    assignedTo,
    olderThanHours,
    limit,
  });
  if (error) return NextResponse.json({ error: `Failed to list exceptions: ${error}` }, { status: 500 });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "exceptions.viewed",
    resource: "rental_exceptions:list",
    detail: { count: rows.length, state: state ?? "all", kind: kind ?? null },
  });
  return NextResponse.json({ configured, exceptions: rows, environment: process.env.VERCEL_ENV ?? "development" });
}
