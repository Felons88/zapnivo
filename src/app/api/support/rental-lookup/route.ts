import { NextResponse } from "next/server";
import { lookupRentals, NOT_FOUND_MESSAGE } from "@/lib/rental-service";
import { rentalLookupSchema } from "@/lib/validation";

/**
 * Rental lookup for customers. Security model (enforced in lookupRentals, shared with the AI assistant):
 *  - Exact match on the payment receipt email is ALWAYS required.
 *  - Strict per-IP and per-email rate limits.
 *  - Identical response for "no such rental" and "rental belongs to someone else".
 *  - Customer-safe projection only (no emails, internal IDs, card data).
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = rentalLookupSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check your details.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });

  const out = await lookupRentals(parsed.data, ip);
  switch (out.status) {
    case "ok": return NextResponse.json({ found: true, results: out.results });
    case "not_found": return NextResponse.json({ found: false, results: [], message: NOT_FOUND_MESSAGE });
    case "rate_limited": return NextResponse.json({ error: "Too many lookups. Please wait a few minutes and try again." }, { status: 429, headers: { "Retry-After": String(out.retryAfter) } });
    case "unconfigured": return NextResponse.json({ error: "Rental lookup becomes available when rentals launch. If you need help now, please open a support ticket.", code: "backend_unconfigured" }, { status: 503 });
    default: return NextResponse.json({ error: "Lookup is unavailable right now. Please try again." }, { status: 500 });
  }
}
