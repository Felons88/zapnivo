import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { createEvent, listEvents } from "@/lib/events-program";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const isoString = z.string().trim().min(10).max(60);
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  venue_id: z.string().uuid().nullable().optional(),
  starts_at: isoString,
  ends_at: isoString,
  max_redemptions: z.number().int().min(1).max(100_000).nullable().optional(),
  package_id: z.string().trim().max(80).nullable().optional(),
  price_cents: z.number().int().min(1).max(10_000_000).nullable().optional(),
}).strict();

const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

/** Organizer: list own event programs. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  return NextResponse.json({ events: await listEvents(db, user.id) });
}

/** Organizer: create an event program (starts as draft). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  if (!rateLimit(`events:create:${ip(req)}`, 10, 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid event.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const d = parsed.data;
  const out = await createEvent(db, user.id, {
    name: d.name, venueId: d.venue_id ?? null, startsAt: d.starts_at, endsAt: d.ends_at,
    maxRedemptions: d.max_redemptions ?? null, packageId: d.package_id ?? null, priceCents: d.price_cents ?? null,
  });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ event: out.data }, { status: 201 });
}
