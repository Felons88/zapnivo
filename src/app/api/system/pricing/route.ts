import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../_shared";
import { systemAudit } from "@/lib/system/audit";

const cents = z.number().int().min(0).max(1_000_000);
const bodySchema = z.object({
  // Optional override fields — anything omitted clones the currently-effective version.
  first_hour_cents: cents.optional(),
  additional_hour_cents: cents.optional(),
  first_24h_cap_cents: cents.nullish(),
  additional_day_cents: cents.nullish(),
  non_return_max_cents: cents.optional(),
  non_return_after_hours: z.number().int().min(1).max(720).optional(),
  hold_cents: cents.optional(),
  approved: z.boolean().optional(),
  note: z.string().max(200).optional(),
});

/**
 * POST /api/system/pricing — create a new pricing_versions row.
 * Permission: system.flags.manage. NEVER mutates an existing version: rentals
 * lock pricing_version at checkout, so editing a row in place would
 * retroactively reprice in-flight rentals. The quote path picks the latest row
 * by effective_at, so the new version takes effect on the next quote.
 * Audited.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.flags.manage", { limit: 30 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must contain positive integer cent amounts (e.g. additional_hour_cents: 299) and optional approved/note." }, { status: 400 });
  }
  const b = parsed.data;

  const { data: latest } = await g.db.from("pricing_versions")
    .select("*")
    .order("effective_at", { ascending: false, nullsFirst: false })
    .limit(1).maybeSingle();
  const base = (latest ?? null) as Record<string, unknown> | null;

  const row = {
    approved: b.approved ?? (base?.approved as boolean | undefined) ?? false,
    first_hour_cents: b.first_hour_cents ?? (base?.first_hour_cents as number | undefined) ?? 0,
    additional_hour_cents: b.additional_hour_cents ?? (base?.additional_hour_cents as number | undefined) ?? 0,
    first_24h_cap_cents: b.first_24h_cap_cents !== undefined ? b.first_24h_cap_cents : (base?.first_24h_cap_cents as number | null | undefined) ?? 0,
    additional_day_cents: b.additional_day_cents !== undefined ? b.additional_day_cents : (base?.additional_day_cents as number | null | undefined) ?? null,
    non_return_max_cents: b.non_return_max_cents ?? (base?.non_return_max_cents as number | undefined) ?? 0,
    non_return_after_hours: b.non_return_after_hours ?? (base?.non_return_after_hours as number | undefined) ?? 24,
    hold_cents: b.hold_cents ?? (base?.hold_cents as number | null | undefined) ?? 1200,
    effective_at: new Date().toISOString(),
  };
  if (!base && (!b.first_hour_cents || !b.additional_hour_cents || !b.non_return_max_cents)) {
    return NextResponse.json({ error: "No existing pricing version to clone — first_hour_cents, additional_hour_cents and non_return_max_cents are required." }, { status: 400 });
  }
  if (row.first_hour_cents <= 0 || row.additional_hour_cents <= 0 || row.non_return_max_cents <= 0) {
    return NextResponse.json({ error: "Hourly rates and the non-return max must be positive." }, { status: 400 });
  }

  const id = `pv-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 7)}`;
  const { error } = await g.db.from("pricing_versions").insert({ id, ...row });
  if (error) return NextResponse.json({ error: "Could not create the pricing version." }, { status: 500 });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "pricing.version.created",
    resource: `pricing_versions:${id}`,
    detail: { ...row, note: b.note ?? null, cloned_from: (base?.id as string | undefined) ?? null },
  });
  return NextResponse.json({ id, ...row });
}
