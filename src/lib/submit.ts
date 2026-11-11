import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { rateLimit } from "./rate-limit";
import { recordLog } from "./observability";
import { serviceClient } from "./supabase";
import { looksLikeCardNumber } from "./validation";

type Opts<T> = {
  req: Request;
  schema: ZodType<T>;
  table: string;
  scope: string;
  map: (data: T) => Record<string, unknown>;
  limit?: number;
  /** Runs after a successful insert (e.g. send a confirmation email). Errors never fail the submission. */
  after?: (data: T, row: { id: string }) => Promise<void>;
};

const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";

/**
 * Shared handler for public forms. Returns success ONLY after the row is persisted.
 * If the backend is not configured it answers 503 so the UI never claims a false success.
 */
export async function handleSubmission<T extends { website?: string }>({ req, schema, table, scope, map, limit = 5, after }: Opts<T>) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const rl = rateLimit(`${scope}:${clientIp(req)}`, limit, 10 * 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many submissions. Please try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please check the highlighted fields.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  }
  const { website, ...data } = parsed.data;
  if (website) return NextResponse.json({ ok: true }); // honeypot: silently drop bots

  if (Object.values(data).some((v) => typeof v === "string" && looksLikeCardNumber(v))) {
    return NextResponse.json({ error: "Please remove anything that looks like a payment card number. We never need it." }, { status: 422 });
  }

  const db = serviceClient();
  if (!db) {
    return NextResponse.json({ error: "Submissions are not available yet. Please email us instead.", code: "backend_unconfigured" }, { status: 503 });
  }
  const { data: row, error } = await db.from(table).insert(map(data as T)).select("id, ticket_number").single();
  if (error) {
    console.error(JSON.stringify({ level: "error", scope, msg: "insert_failed", code: error.code }));
    recordLog("error", "form_submit_failed", { service: scope, attrs: { table, code: error.code } });
    return NextResponse.json({ error: "We couldn't save your submission. Please try again." }, { status: 500 });
  }
  recordLog("info", "form_submitted", { service: scope, attrs: { table, id: row.id } });
  if (after) { try { await after(data as T, row as { id: string }); } catch { /* notification failure never fails the submission */ } }
  return NextResponse.json({ ok: true, id: row.id, ticketNumber: row.ticket_number });
}
