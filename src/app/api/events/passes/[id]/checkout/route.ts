import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { passPriceCents } from "@/lib/events-program";
import { rateLimit } from "@/lib/rate-limit";
import { SITE } from "@/lib/site";
import { createEventPassCheckout } from "@/lib/monetization/checkout";
import { stripeConfigured } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";
import { recordLog } from "@/lib/observability";

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(200) }).strict();

const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

/**
 * Creates a Stripe Checkout session for an unpaid event pass. Price comes from
 * the event (price_cents, else attached package) — never from the client.
 * The webhook stamps paid_at; redemption stays blocked until then.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  if (!stripeConfigured()) return NextResponse.json({ error: "Payments aren't configured yet." }, { status: 503 });
  const { id } = await params;
  if (!rateLimit(`events:passcheckout:${ip(req)}`, 10, 10 * 60_000).ok) {
    return NextResponse.json({ error: "Too many attempts. Please try again shortly." }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });

  const priced = await passPriceCents(db, id);
  if (!priced.ok) return NextResponse.json({ error: priced.error }, { status: priced.status });

  const base = SITE.url.replace(/\/$/, "");
  const session = await createEventPassCheckout({
    passId: id, eventName: priced.data.eventName, amountCents: priced.data.priceCents,
    email: parsed.data.email,
    successUrl: `${base}/account/events?paid=1`,
    cancelUrl: `${base}/account/events?paid=0`,
  });
  if (!session.ok || !session.data.url) {
    recordLog("error", "event_pass_checkout_failed", { service: "events", route: "pass-checkout", attrs: { pass: id.slice(0, 8) } });
    return NextResponse.json({ error: "Payment couldn't be started. Please try again." }, { status: 502 });
  }
  // Best-effort: remember the session id (webhook overwrites with the completed one).
  await db.from("event_passes").update({ stripe_checkout_session_id: session.data.id }).eq("id", id).is("paid_at", null);
  return NextResponse.json({ checkout_url: session.data.url }, { status: 201 });
}
