import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getEvent, updateEvent } from "@/lib/events-program";
import { serviceClient } from "@/lib/supabase";

const optStr = z.string().trim().max(200).nullable().optional();
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  venue_id: z.string().uuid().nullable().optional(),
  starts_at: optStr,
  ends_at: optStr,
  max_redemptions: z.number().int().min(1).max(100_000).nullable().optional(),
  package_id: z.string().trim().max(80).nullable().optional(),
  price_cents: z.number().int().min(1).max(10_000_000).nullable().optional(),
}).strict();

/** Organizer: event detail + pass/redemption stats. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  const out = await getEvent(db, user.id, id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json(out.data);
}

/** Organizer: edit event fields (status changes go through /transition). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid update.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const d = parsed.data;
  const out = await updateEvent(db, user.id, id, {
    name: d.name, venueId: d.venue_id, startsAt: d.starts_at ?? undefined, endsAt: d.ends_at ?? undefined,
    maxRedemptions: d.max_redemptions, packageId: d.package_id, priceCents: d.price_cents,
  });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ event: out.data });
}
