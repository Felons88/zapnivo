import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { hashPassCode } from "@/lib/events-program";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";

const uuid = z.string().uuid();

/**
 * Staff/admin event operations.
 * GET  ?code=XXXX-…  → pass lookup by full code (hashes it server-side; never returns the hash).
 * POST form actions: set_status {event_id,to} | set_price {event_id,price_cents} | revoke_pass {pass_id}
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Staff only." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });

  const code = req.nextUrl.searchParams.get("code")?.trim().toUpperCase() ?? "";
  if (!code) return NextResponse.json({ error: "Pass a ?code= parameter." }, { status: 422 });
  const { data: pass } = await db.from("event_passes")
    .select("id,event_id,holder_id,units_granted,units_used,expires_at,status,paid_at,created_at")
    .eq("code_hash", hashPassCode(code)).maybeSingle();
  if (!pass) return NextResponse.json({ error: "No pass matches that code." }, { status: 404 });
  const { data: event } = await db.from("event_programs")
    .select("id,name,status,starts_at,ends_at,organizer_id").eq("id", pass.event_id).maybeSingle();
  return NextResponse.json({ pass, event });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Staff only." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });

  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const back = (q = "") => NextResponse.redirect(new URL(`/admin/events${q}`, req.url), 303);

  if (action === "set_status") {
    const eventId = String(form.get("event_id") ?? "");
    const to = String(form.get("to") ?? "");
    if (!uuid.safeParse(eventId).success || !["draft", "active", "paused", "closed", "cancelled"].includes(to)) {
      return NextResponse.json({ error: "Invalid request." }, { status: 422 });
    }
    const { data: cur } = await db.from("event_programs").select("id,status").eq("id", eventId).maybeSingle();
    if (!cur) return NextResponse.json({ error: "Event not found." }, { status: 404 });
    // Admin override: same terminal-state rules, but bypasses the organizer window check.
    const allowed: Record<string, string[]> = {
      draft: ["active", "cancelled"], active: ["paused", "closed", "cancelled"],
      paused: ["active", "closed", "cancelled"], closed: [], cancelled: [],
    };
    if (!(allowed[cur.status] ?? []).includes(to)) {
      return NextResponse.json({ error: `Can't move '${cur.status}' → '${to}'.` }, { status: 409 });
    }
    const { data, error } = await db.from("event_programs").update({ status: to })
      .eq("id", eventId).eq("status", cur.status).select("id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "Couldn't update the event." }, { status: 500 });
    await auditLog(user!.id, `event_status_${to}`, "event_program", eventId, { from: cur.status, to });
    recordLog("info", "admin_event_status", { service: "events", attrs: { event: eventId.slice(0, 8), from: cur.status, to } });
    return back(`?done=status`);
  }

  if (action === "set_price") {
    const eventId = String(form.get("event_id") ?? "");
    const cents = Number(form.get("price_cents"));
    if (!uuid.safeParse(eventId).success || !Number.isInteger(cents) || cents <= 0 || cents > 10_000_000) {
      return NextResponse.json({ error: "Price must be a positive whole number of cents." }, { status: 422 });
    }
    const { data, error } = await db.from("event_programs").update({ price_cents: cents })
      .eq("id", eventId).select("id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "Event not found or update failed." }, { status: 404 });
    await auditLog(user!.id, "event_price_set", "event_program", eventId, { price_cents: cents });
    return back(`?done=price`);
  }

  if (action === "revoke_pass") {
    const passId = String(form.get("pass_id") ?? "");
    if (!uuid.safeParse(passId).success) return NextResponse.json({ error: "Invalid pass." }, { status: 422 });
    const { data, error } = await db.from("event_passes").update({ status: "revoked" })
      .eq("id", passId).neq("status", "redeemed").select("id,event_id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "Pass not found or already redeemed." }, { status: 409 });
    await auditLog(user!.id, "event_pass_revoked", "event_pass", passId, { event_id: data.event_id });
    recordLog("warning", "admin_pass_revoked", { service: "events", attrs: { pass: passId.slice(0, 8) } });
    return back(`?done=revoked`);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
