import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";
import { fingerprint, scrub, scrubAttrs } from "@/lib/observability";

const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("error"),
    name: z.string().max(80).default("Error"),
    message: z.string().max(2000).default(""),
    stack: z.string().max(12000).optional(),
    route: z.string().max(300).optional(),
    release: z.string().max(40).optional(),
    severity: z.enum(["error", "critical", "warning"]).default("error"),
    user_agent: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal("vital"),
    name: z.enum(["LCP", "INP", "CLS", "TTFB", "FCP"]),
    value: z.number().nonnegative().max(600000),
    route: z.string().max(300).optional(),
    device: z.string().max(40).optional(),
    browser: z.string().max(40).optional(),
  }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warning", "error", "critical"]),
    message: z.string().max(2000),
    route: z.string().max(300).optional(),
    attrs: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("feedback"),
    message: z.string().min(1).max(4000),
    route: z.string().max(300).optional(),
    contact: z.string().max(200).optional(),
  }),
]);

/** Browser telemetry ingestion. Errors are captured regardless of analytics consent (they're operational, not tracking); vitals/logs are sent only when the client chooses. */
export async function POST(req: NextRequest) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Telemetry unavailable." }, { status: 503 });
  if (!rateLimit(`telemetry:${ip(req)}`, 120, 60_000).ok) return NextResponse.json({ error: "Too many events." }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid telemetry." }, { status: 422 });
  const t = parsed.data;

  if (t.type === "error") {
    const fp = fingerprint({ name: t.name, message: t.message, stack: t.stack, route: t.route });
    await db.from("error_events").insert({
      fingerprint: fp,
      title: `${t.name}: ${scrub(t.message, 200)}`,
      message: scrub(t.message),
      stack: scrub(t.stack, 8000),
      route: t.route ?? null,
      release: t.release ?? null,
      environment: "production",
      runtime: "browser",
      severity: t.severity,
      user_agent: scrub(t.user_agent, 300) || null,
    });
    const { data: existing } = await db.from("error_issues").select("id,status,event_count").eq("fingerprint", fp).maybeSingle();
    const now = new Date().toISOString();
    if (existing) {
      const ex = existing as { id: string; status: string; event_count: number };
      await db.from("error_issues").update({
        last_seen: now, event_count: ex.event_count + 1,
        ...(ex.status === "resolved" ? { status: "regressed", resolved_at: null } : {}),
      }).eq("fingerprint", fp);
    } else {
      await db.from("error_issues").insert({
        fingerprint: fp, title: `${t.name}: ${scrub(t.message, 160)}`, culprit: t.route ?? null,
        severity: t.severity, first_seen: now, last_seen: now, event_count: 1,
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (t.type === "vital") {
    await db.from("app_logs").insert({
      level: "info", service: "web-vitals", route: t.route ?? null,
      message: `${t.name}=${Math.round(t.value)}`,
      attrs: scrubAttrs({ name: t.name, value: Math.round(t.value * 100) / 100, device: t.device, browser: t.browser }),
    });
    return NextResponse.json({ ok: true });
  }

  if (t.type === "log") {
    await db.from("app_logs").insert({
      level: t.level, service: "browser", route: t.route ?? null,
      message: scrub(t.message, 1000), attrs: scrubAttrs(t.attrs),
    });
    return NextResponse.json({ ok: true });
  }

  // feedback → routed into the existing helpdesk as a ticket so there's one support system.
  const { defaultCtx } = await import("@/lib/helpdesk/service");
  const ctx = await defaultCtx();
  if (!ctx) return NextResponse.json({ ok: true, stored: false });
  const { createTicket } = await import("@/lib/helpdesk/service");
  await createTicket(ctx, {
    requesterType: "customer",
    name: "Website feedback",
    email: "feedback@zapnivo.com",
    category: "general",
    subject: `Site feedback${t.route ? ` (${scrub(t.route, 80)})` : ""}`,
    description: scrub(t.message, 3900),
  });
  return NextResponse.json({ ok: true });
}
