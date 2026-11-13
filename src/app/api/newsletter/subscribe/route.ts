import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { recordLog } from "@/lib/observability";
import { newsletterSubscribeSchema } from "@/lib/newsletter/core";
import { subscribe } from "@/lib/newsletter/service";

const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";

/**
 * POST /api/newsletter/subscribe — public double opt-in capture.
 * Body: { email, segment: "customer"|"business", consent: true, source?, website? }
 * `website` is a honeypot — bots get a silent ok, humans get pending → DOI email.
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const rl = rateLimit(`newsletter:${clientIp(req)}`, 5, 10 * 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const parsed = newsletterSubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please check the form and try again.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  }
  const { website, ...data } = parsed.data;
  if (website) return NextResponse.json({ ok: true }); // honeypot: silently drop bots

  const res = await subscribe(data);
  if (!res.ok) {
    recordLog("error", "newsletter_subscribe_failed", { service: "newsletter", route: "subscribe", attrs: { status: res.status } });
    return NextResponse.json({ error: res.error }, { status: res.status });
  }
  // Generic success — never reveal whether the address was already known.
  return NextResponse.json({ ok: true });
}
