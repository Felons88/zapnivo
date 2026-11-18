import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { emitByEmail, NOTIFY_TEMPLATES, NOTIFY_VARS } from "@/lib/notify";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KIND_RE = /^[a-z0-9_]{2,60}$/;

function back(req: Request, result: string, detail: string) {
  const url = new URL("/admin/notifications", req.url);
  url.searchParams.set("result", result);
  url.searchParams.set("detail", detail.slice(0, 200));
  return NextResponse.redirect(url, 303);
}

/** Placeholder names used in a template — every one must be a whitelisted var. */
const placeholders = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

/**
 * Notification management actions. Viewing is staff; every mutation is
 * admin-only — template edits change customer-facing copy, test sends and
 * campaigns generate real notifications, and event requeues can re-deliver.
 * `essential` and enable-state are enforced from the code registry: an
 * essential kind can never be disabled or downgraded through this UI.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (user!.role !== "admin") return back(req, "error", "Notification management is admin-only.");
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = Object.fromEntries(await req.formData()) as Record<string, string>;
  const kind = (form.kind ?? "").trim();

  /* ── Template override: validates kind exists + every placeholder is whitelisted. ── */
  if (form.action === "save_template") {
    const p = z.object({ title: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(1000) }).safeParse({ title: form.title, body: form.body });
    const base = NOTIFY_TEMPLATES[kind];
    if (!p.success || !KIND_RE.test(kind) || !base) return back(req, "error", "Unknown event kind or invalid template.");
    const unknown = [...placeholders(p.data.title), ...placeholders(p.data.body)].filter((v) => !NOTIFY_VARS.has(v));
    if (unknown.length) return back(req, "error", `Unknown variable(s): ${unknown.join(", ")} — allowed: ${[...NOTIFY_VARS].join(" ")}.`);
    const { error } = await db.from("notification_templates").upsert({
      kind, category: base.category, title: p.data.title, body: p.data.body,
      channels: base.channels, essential: base.essential, enabled: true, updated_at: new Date().toISOString(),
    });
    if (error) return back(req, "error", "Couldn't save the template.");
    await auditLog(user!.id, "notification_template_saved", "notification_template", kind);
    return back(req, "ok", `Template "${kind}" saved — it renders on the next event.`);
  }

  if (form.action === "reset_template") {
    if (!KIND_RE.test(kind)) return back(req, "error", "Unknown event kind.");
    await db.from("notification_templates").delete().eq("kind", kind);
    await auditLog(user!.id, "notification_template_reset", "notification_template", kind);
    return back(req, "ok", `Template "${kind}" reverted to the built-in copy.`);
  }

  if (form.action === "toggle_template") {
    const base = NOTIFY_TEMPLATES[kind];
    if (!base) return back(req, "error", "Unknown event kind.");
    if (base.essential) return back(req, "error", "Essential notifications can't be disabled — they're required for account and payment truth.");
    const next = form.enabled === "true";
    const { error } = await db.from("notification_templates").upsert({
      kind, category: base.category, title: base.title, body: base.body,
      channels: base.channels, essential: false, enabled: next, updated_at: new Date().toISOString(),
    }, { onConflict: "kind" });
    if (error) return back(req, "error", "Couldn't update the event.");
    await auditLog(user!.id, next ? "notification_event_enabled" : "notification_event_disabled", "notification_template", kind);
    return back(req, "ok", `"${kind}" is now ${next ? "enabled" : "disabled"}.`);
  }

  /* ── Failed-queue: requeue dead/failed events for the next sweep. ── */
  if (form.action === "requeue_event") {
    const id = z.coerce.number().int().positive().safeParse(form.id);
    if (!id.success) return back(req, "error", "Bad event id.");
    const { error } = await db.from("notification_events")
      .update({ status: "queued", attempts: 0, due_at: new Date().toISOString(), last_error: null })
      .eq("id", id.data).in("status", ["failed", "dead"]);
    if (error) return back(req, "error", "Couldn't requeue the event.");
    await auditLog(user!.id, "notification_event_requeued", "notification_event", String(id.data));
    return back(req, "ok", "Event requeued — the sweep retries it within minutes.");
  }

  /* ── Test send to one address — resolves profile by email like real events. ── */
  if (form.action === "test_send") {
    const email = (form.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return back(req, "error", "Enter a valid customer email.");
    if (!NOTIFY_TEMPLATES[kind]) return back(req, "error", "Unknown event kind.");
    let vars: Record<string, string> = {};
    try { vars = form.vars ? JSON.parse(form.vars) : {}; } catch { return back(req, "error", "Vars must be a JSON object like {\"amount\": \"$5.00\"}."); }
    try {
      await emitByEmail(db, email, { kind, vars, actor: `test:${user!.id}`, correlationId: `test:${Date.now()}`, deepLink: "notifications" });
    } catch (e) {
      return back(req, "error", e instanceof Error ? e.message : "Send failed.");
    }
    await auditLog(user!.id, "notification_test_sent", "customer", email, { kind });
    return back(req, "ok", `Test "${kind}" sent to ${email} — check Deliveries for the result.`);
  }

  /* ── Campaign: optional-offer broadcast, gated on the recipient's own pref. ── */
  if (form.action === "campaign") {
    const campKind = kind === "product_update" ? "product_update" : "promo_offer";
    const p = z.object({ title: z.string().trim().min(3).max(160), body: z.string().trim().min(10).max(1000) }).safeParse({ title: form.title, body: form.body });
    if (!p.success) return back(req, "error", "Campaign needs a title (3–160 chars) and body (10–1000 chars).");
    const campaignId = `camp:${Date.now().toString(36)}`;
    // Recipients: profiles that haven't opted out of offers/product_updates.
    const prefCol = campKind === "product_update" ? "product_updates" : "offers";
    const [{ data: optedOut }, { data: profiles }] = await Promise.all([
      db.from("customer_notification_prefs").select("profile_id").eq(prefCol, false),
      db.from("profiles").select("id").in("role", ["customer"]).limit(5000),
    ]);
    const skip = new Set(((optedOut ?? []) as { profile_id: string }[]).map((r) => r.profile_id));
    const rows = ((profiles ?? []) as { id: string }[])
      .filter((r) => !skip.has(r.id))
      .map((r) => ({
        profile_id: r.id, kind: campKind, status: "queued",
        vars: campKind === "promo_offer" ? { promo: p.data.title, reason: p.data.body } : { reason: `${p.data.title} — ${p.data.body}` },
        actor: `campaign:${user!.id}`, dedupe_key: `${campaignId}:${r.id}`,
      }));
    if (!rows.length) return back(req, "error", "No eligible recipients — everyone opted out of this category.");
    const { error } = await db.from("notification_events").insert(rows);
    if (error) return back(req, "error", "Couldn't queue the campaign.");
    await auditLog(user!.id, "notification_campaign_queued", "notification_event", campaignId, { kind: campKind, recipients: rows.length, title: p.data.title });
    return back(req, "ok", `Campaign queued for ${rows.length.toLocaleString()} opted-in customers — drains through the normal sweep.`);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
