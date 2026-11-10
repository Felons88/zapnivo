import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";
import { isPublicEvent, sanitizeProps } from "@/lib/analytics";

const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

const schema = z.object({
  event_id: z.string().uuid().optional(),
  name: z.string().min(1).max(64),
  props: z.unknown().optional(),
  session_ref: z.string().max(64).regex(/^[\w-]*$/).optional(),
  consent_state: z.enum(["granted", "denied", "unknown"]).optional(),
  path: z.string().max(300).optional(),
}).strict();

/** Public first-party analytics ingestion. Allowlisted event names only — server lifecycle events are rejected here by design. */
export async function POST(req: NextRequest) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Analytics unavailable." }, { status: 503 });
  if (!rateLimit(`events:${ip(req)}`, 60, 60_000).ok) return NextResponse.json({ error: "Too many events." }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid event." }, { status: 422 });
  const { name, event_id, session_ref, consent_state } = parsed.data;
  if (!isPublicEvent(name)) return NextResponse.json({ error: "Unknown event." }, { status: 422 });

  const props = sanitizeProps(parsed.data.props);
  if (parsed.data.path) props.path = parsed.data.path.split("?")[0].split("#")[0].slice(0, 200);

  const { error } = await db.from("business_events").insert({
    event_id: event_id ?? undefined,
    name,
    source: "client",
    session_ref: session_ref ?? null,
    consent_state: consent_state ?? "unknown",
    props,
  });
  // 23505 = duplicate event_id → idempotent success.
  if (error && error.code !== "23505") {
    console.error(JSON.stringify({ level: "error", scope: "events", msg: error.message }));
    return NextResponse.json({ error: "Could not record event." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
