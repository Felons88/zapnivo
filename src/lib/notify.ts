import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "./observability";
import { fmt } from "./pricing";

/**
 * Centralized customer notification engine.
 *
 * Producers (admin mutations, auth, Stripe webhook, helpdesk, wallet, rental
 * lifecycle) call `emit()` — it writes a durable notification_events outbox
 * row (a failed insert throws, so a mutation can never silently lose its
 * notification) and then drains it in-band. The /api/cron/notifications sweep
 * (pg_cron, every 5 min) retries anything that didn't deliver.
 *
 * Delivery fans out to channels per template:
 *  - in_app — a persistent `notifications` row (the app center + unread badge,
 *    realtime-synced). ALWAYS attempted — it is the durable record.
 *  - push   — FCM via pushToUser (respects the push_enabled kill switch).
 *  - email  — enqueued to email_outbox for essential/security/financial kinds.
 *  - sms    — only for explicitly SMS-allowed kinds (compliance).
 *
 * Template variables {like_this} are interpolated from a whitelisted var set;
 * an unresolved placeholder fails the event rather than shipping "{var}" to a
 * customer. Notification bodies carry safe display vars only — never tokens,
 * PANs, full card data, or secrets.
 */

export type NotifyChannel = "in_app" | "push" | "email" | "sms";
export type NotifyCategory = "account" | "security" | "payment" | "rental" | "support" | "offer";

export type NotifyTemplate = {
  category: NotifyCategory;
  title: string;
  body: string;
  channels: NotifyChannel[];
  essential: boolean;
};

/** Deep-link allowlist — the only targets a notification may carry. */
const DEEP_LINK_RE = /^(rental:[A-Z0-9-]{4,20}|ticket:Z-[0-9]{3,10}|wallet|account|notifications|support)$/;

/**
 * Whitelisted template variables. Anything not in this set can never reach a
 * customer message — it throws at render time instead.
 */
export const NOTIFY_VARS = new Set([
  "first_name", "name", "amount", "currency", "balance", "last4", "station_name",
  "city", "rental_duration", "ticket_id", "agent_name", "event_time", "card_ref",
  "rental_ref", "deadline", "fee", "charges", "reason", "brand", "device", "hi",
  "location", "app_version", "promo", "units", "count", "url", "email", "phone_tail",
]);

const money = (cents: number) => fmt(cents);

/** Code-side template registry — notification_templates rows override by kind. */
export const NOTIFY_TEMPLATES: Record<string, NotifyTemplate> = {
  /* account */
  profile_updated:      { category: "account", essential: true, channels: ["in_app", "push"], title: "Your profile was updated", body: "{hi}Support updated your account details{reason}. If this wasn't you, contact support from the app." },
  email_changed:        { category: "account", essential: true, channels: ["in_app", "push", "email"], title: "Your sign-in email changed", body: "Your Zapnivo account email is now {email}. If you didn't request this, contact support immediately." },
  phone_changed:        { category: "account", essential: true, channels: ["in_app", "push"], title: "Your phone number changed", body: "The phone on your Zapnivo account now ends in {phone_tail}. If this wasn't you, contact support." },
  card_reissued:        { category: "account", essential: true, channels: ["in_app", "push", "email"], title: "New Zapnivo card issued", body: "Your replacement prepaid card •••• {last4} is ready — {reason}. Your balance carried over." },
  account_suspended:    { category: "account", essential: true, channels: ["in_app", "push", "email"], title: "Your account was suspended", body: "Your Zapnivo account was suspended{reason}. Contact support if you think this is a mistake." },
  account_restored:     { category: "account", essential: true, channels: ["in_app", "push", "email"], title: "Your account is active again", body: "Your Zapnivo account suspension was lifted — you can rent and top up again." },
  /* security */
  new_signin:           { category: "security", essential: true, channels: ["in_app", "push", "email"], title: "New sign-in to your account", body: "A new {device} session started{location}. If this wasn't you, sign out everywhere from Settings → Security." },
  password_reset:       { category: "security", essential: true, channels: ["in_app", "email"], title: "Password reset requested", body: "A password reset was requested for your account. If you didn't ask for it, you can ignore this — your password is unchanged." },
  sessions_revoked:     { category: "security", essential: true, channels: ["in_app", "push", "email"], title: "You were signed out everywhere", body: "All sessions on your Zapnivo account were revoked{reason}. Sign in again on your devices." },
  /* payment */
  credit_granted:       { category: "payment", essential: true, channels: ["in_app", "push", "email"], title: "Credit added to your account", body: "{hi}we added {amount} of credit{reason}. It applies automatically on your next rental." },
  funds_added:          { category: "payment", essential: true, channels: ["in_app", "push", "email"], title: "{amount} added to your wallet", body: "{hi}{amount} was added to your Zapnivo wallet{reason} — ready for your next rental." },
  wallet_topup_paid:    { category: "payment", essential: true, channels: ["in_app", "push", "email"], title: "{amount} added to your wallet", body: "{hi}your top-up was received{card_ref} — ready at any Zapnivo machine." },
  refund_issued:        { category: "payment", essential: true, channels: ["in_app", "push", "email"], title: "Refund issued: {amount}", body: "{hi}a refund of {amount} was issued{card_ref}. It usually lands within 5–10 business days." },
  charge_captured:      { category: "payment", essential: true, channels: ["in_app", "push"], title: "Rental charge: {amount}", body: "{rental_ref} settled at {amount}{last4}. See the receipt in your wallet." },
  dispute_opened:       { category: "payment", essential: true, channels: ["in_app", "push", "email"], title: "A chargeback was filed", body: "Your bank opened a dispute on a Zapnivo charge{amount}. We'll share the receipt with them — contact support if this was a mistake." },
  payment_method_added: { category: "payment", essential: true, channels: ["in_app", "push"], title: "Card saved: {brand} •••• {last4}", body: "A {brand} card ending {last4} was linked to your account for rentals and top-ups." },
  payment_method_removed: { category: "payment", essential: true, channels: ["in_app", "push"], title: "Card removed: •••• {last4}", body: "Your {brand} card ending {last4} was unlinked from your Zapnivo account." },
  /* rental */
  rental_started:       { category: "rental", essential: true, channels: ["in_app"], title: "Rental {rental_ref} started", body: "{station_name} — return by {deadline}. {charges} so far." },
  rental_dispensed:     { category: "rental", essential: true, channels: ["in_app"], title: "Charger dispensed", body: "Rental {rental_ref} — power bank released at {station_name}." },
  rental_returned:      { category: "rental", essential: true, channels: ["in_app", "push"], title: "Rental {rental_ref} complete", body: "Returned{station_name} — final charge {amount}. Thanks for renting." },
  rental_reminder:      { category: "rental", essential: false, channels: ["in_app"], title: "Rental {rental_ref} running", body: "{charges} accrued — return by {deadline}." },
  rental_fee:           { category: "rental", essential: true, channels: ["in_app", "push", "email"], title: "Rental fee: {amount}", body: "{hi}the {fee} fee for {rental_ref} was charged to your card on file." },
  rental_paused:        { category: "rental", essential: true, channels: ["in_app"], title: "Rental {rental_ref} paused", body: "The hourly clock is stopped. Return to any station when you're done." },
  /* support */
  ticket_created:       { category: "support", essential: true, channels: ["in_app"], title: "Request {ticket_id} received", body: "We got your support request — replies land here and by email." },
  support_reply:        { category: "support", essential: true, channels: ["in_app"], title: "New reply on {ticket_id}", body: "{agent_name} replied to your support request — tap to read it." },
  ticket_resolved:      { category: "support", essential: true, channels: ["in_app"], title: "{ticket_id} resolved", body: "Your support request was marked resolved. Reply inside the thread if anything's still wrong." },
  /* offer (optional — preference-gated, quiet hours apply) */
  promo_offer:          { category: "offer", essential: false, channels: ["in_app", "push"], title: "{promo}", body: "{hi}{reason}" },
  product_update:       { category: "offer", essential: false, channels: ["in_app", "push"], title: "What's new in Zapnivo", body: "{reason}" },
  reward_earned:        { category: "offer", essential: false, channels: ["in_app", "push"], title: "Reward earned", body: "{reason}" },
};

/** Optional-category pref column → categories it gates. Essential kinds are never gated. */
const PREF_FOR_CATEGORY: Partial<Record<NotifyCategory, string>> = {
  offer: "offers",
  rental: "rental_reminders",
  support: "support_updates",
};

export type EmitInput = {
  profileId: string;
  kind: string;
  vars?: Record<string, string | number | null | undefined>;
  deepLink?: string;
  dedupeKey?: string;
  actor?: string;
  correlationId?: string;
};

/** Renders title/body; throws when a placeholder can't be resolved — never send "{var}". */
export function renderTemplate(tpl: { title: string; body: string }, vars: Record<string, string>): { title: string; body: string } {
  const fill = (t: string) => {
    const out = t.replace(/\{(\w+)\}/g, (m, key: string) => {
      if (!NOTIFY_VARS.has(key)) throw new Error(`unknown_template_var:${key}`);
      const v = vars[key];
      if (v === undefined) throw new Error(`missing_template_var:${key}`);
      return v.replace(/[{}]/g, "").slice(0, 200);
    });
    return out.replace(/\s+/g, " ").trim();
  };
  const title = fill(tpl.title), body = fill(tpl.body);
  if (!title || !body) throw new Error("empty_render");
  return { title, body };
}

/** Normalizes vars: numbers → formatted strings, null → "" (callers still must provide required keys). */
export function normalizeVars(vars: EmitInput["vars"], firstName?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "number" ? money(v) : String(v);
  }
  const first = firstName?.trim().split(/\s+/)[0];
  out.first_name = first ?? "there";
  out.hi = first ? `${first}, ` : ""; // "{hi}rest of sentence" → "James, rest…" / "Rest…"
  return out;
}

type Prefs = { offers: boolean; product_updates: boolean; rental_reminders: boolean; support_updates: boolean; rewards: boolean; quiet_start: number | null; quiet_end: number | null; timezone: string };

async function loadPrefs(db: SupabaseClient, profileId: string): Promise<Prefs> {
  const { data } = await db.from("customer_notification_prefs").select("offers,product_updates,rental_reminders,support_updates,rewards,quiet_start,quiet_end,timezone").eq("profile_id", profileId).maybeSingle();
  const p = data as Prefs | null;
  return { offers: p?.offers ?? true, product_updates: p?.product_updates ?? true, rental_reminders: p?.rental_reminders ?? true, support_updates: p?.support_updates ?? true, rewards: p?.rewards ?? true, quiet_start: p?.quiet_start ?? null, quiet_end: p?.quiet_end ?? null, timezone: p?.timezone ?? "America/Chicago" };
}

/** True when local time is inside the quiet window (windows may wrap midnight). */
export function inQuietHours(prefs: Pick<Prefs, "quiet_start" | "quiet_end" | "timezone">, now = new Date()): boolean {
  const s = prefs.quiet_start, e = prefs.quiet_end;
  if (s === null || s === undefined || e === null || e === undefined) return false;
  let hour: number;
  try { hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: prefs.timezone }).format(now)); }
  catch { hour = now.getUTCHours(); }
  return s <= e ? hour >= s && hour < e : hour >= s || hour < e;
}

async function loadTemplate(db: SupabaseClient, kind: string): Promise<NotifyTemplate | null> {
  const { data } = await db.from("notification_templates").select("category,title,body,channels,essential,enabled").eq("kind", kind).maybeSingle();
  const row = data as (NotifyTemplate & { enabled: boolean }) | null;
  if (row) return row.enabled ? { category: row.category, title: row.title, body: row.body, channels: row.channels, essential: row.essential } : null;
  return NOTIFY_TEMPLATES[kind] ?? null;
}

/** Per-channel delivery; writes notification_deliveries rows, never throws. */
async function deliver(
  db: SupabaseClient,
  notificationId: string, channel: NotifyChannel,
  run: () => Promise<string>,
): Promise<"sent" | "failed" | "skipped"> {
  try {
    const detail = await run();
    await db.from("notification_deliveries").upsert({ notification_id: notificationId, channel, status: "sent", detail }, { onConflict: "notification_id,channel" }).then(() => undefined, () => undefined);
    return "sent";
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 240) : "send_error";
    await db.from("notification_deliveries").upsert({ notification_id: notificationId, channel, status: "failed", detail: msg }, { onConflict: "notification_id,channel" }).then(() => undefined, () => undefined);
    return "failed";
  }
}

const recordDelivery = (db: SupabaseClient, notificationId: string, channel: NotifyChannel, status: "skipped" | "deferred" | "sent" | "failed", detail: string) =>
  db.from("notification_deliveries").upsert({ notification_id: notificationId, channel, status, detail }, { onConflict: "notification_id,channel" }).then(() => undefined, () => undefined);

/** Processes one outbox event → notification row + channel fan-out. */
export async function deliverEvent(db: SupabaseClient, event: {
  id: number; profile_id: string; kind: string; vars: Record<string, string>;
  actor: string | null; correlation_id: string | null; dedupe_key: string | null;
}): Promise<"done" | "failed"> {
  const tpl = await loadTemplate(db, event.kind);
  if (!tpl) {
    await db.from("notification_events").update({ status: "dead", last_error: `unknown_kind:${event.kind}` }).eq("id", event.id);
    return "failed";
  }
  const { data: prof } = await db.from("profiles").select("email,full_name").eq("id", event.profile_id).maybeSingle();
  const p = prof as { email: string | null; full_name: string | null } | null;
  const vars = normalizeVars(event.vars, p?.full_name);

  let rendered: { title: string; body: string };
  try {
    rendered = renderTemplate(tpl, vars);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "render_error";
    await db.from("notification_events").update({ status: "dead", last_error: msg.slice(0, 240) }).eq("id", event.id);
    recordLog("error", "notify_render_failed", { service: "notify", attrs: { kind: event.kind, error: msg } });
    return "failed";
  }

  // Durable in-app record — dedupe_key makes re-emission a no-op. A quiet-hours
  // requeue carries vars._attach to reuse the original notification instead of
  // creating a duplicate in-app row.
  const dedupe = event.dedupe_key ?? `event:${event.id}`;
  const evVars = event.vars as Record<string, string>;
  const attach = typeof evVars._attach === "string" ? evVars._attach : null;
  const data: Record<string, string> = { kind: event.kind };
  if (evVars.deep_link && DEEP_LINK_RE.test(evVars.deep_link)) data.deep_link = evVars.deep_link;
  let nid: string | null = null;
  if (attach) {
    const { data: prior } = await db.from("notifications").select("id").eq("dedupe_key", attach).maybeSingle();
    nid = (prior as { id: string } | null)?.id ?? null;
    if (!nid) { await db.from("notification_events").update({ status: "done", processed_at: new Date().toISOString() }).eq("id", event.id); return "done"; }
  } else {
    const { data: notif, error: insErr } = await db.from("notifications")
      .insert({ profile_id: event.profile_id, category: tpl.category, kind: event.kind, title: rendered.title, body: rendered.body, data, dedupe_key: dedupe })
      .select("id").maybeSingle();
    if (insErr) {
      // Dedupe conflict = a concurrent/replayed delivery already wrote the row — done, not failed.
      const isDedupe = (insErr as { code?: string }).code === "23505";
      await db.from("notification_events").update({
        status: isDedupe ? "done" : "failed", processed_at: new Date().toISOString(),
        ...(isDedupe ? {} : { last_error: insErr.message.slice(0, 240), attempts: 1 }),
      }).eq("id", event.id);
      return isDedupe ? "done" : "failed";
    }
    if (!notif) { await db.from("notification_events").update({ status: "done", processed_at: new Date().toISOString() }).eq("id", event.id); return "done"; }
    nid = (notif as { id: string }).id;
    await recordDelivery(db, nid, "in_app", "sent", "recorded");
  }

  // Preference + quiet-hours gating on optional categories.
  const prefs = await loadPrefs(db, event.profile_id);
  const prefCol = PREF_FOR_CATEGORY[tpl.category];
  const optedOut = !tpl.essential && prefCol ? (prefs as unknown as Record<string, boolean>)[prefCol] === false : false;
  const quiet = !tpl.essential && inQuietHours(prefs);

  for (const ch of tpl.channels) {
    if (ch === "in_app") continue;
    if (optedOut) { await recordDelivery(db, nid, ch, "skipped", "preference_off"); continue; }
    if (quiet) {
      await recordDelivery(db, nid, ch, "deferred", "quiet_hours");
      // Requeue a push for when quiet hours end (roughly: next boundary hour).
      if (ch === "push" || ch === "email") {
        const next = new Date(); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
        await db.from("notification_events").insert({
          profile_id: event.profile_id, kind: event.kind,
          vars: { ...evVars, _attach: dedupe },
          dedupe_key: `${dedupe}:quiet`, status: "queued", due_at: next.toISOString(), actor: event.actor, correlation_id: event.correlation_id,
        }).then(() => undefined, () => undefined);
      }
      continue;
    }
    if (ch === "push") {
      const { pushToUser } = await import("./push");
      await deliver(db, nid, "push", async () => {
        const diag: { reason?: string } = {};
        const n = await pushToUser(event.profile_id, { title: rendered.title, body: rendered.body, data }, db, diag);
        if (n === 0) throw new Error(diag.reason ?? "not_sent");
        return `${n} device(s)`;
      });
    } else if (ch === "email") {
      const email = p?.email;
      if (!email || email.endsWith("@mobile.zapnivo.com")) { await recordDelivery(db, nid, "email", "skipped", "no_deliverable_email"); continue; }
      await deliver(db, nid, "email", async () => {
        const { sendToCustomer } = await import("./email-triggers");
        await sendToCustomer(email, rendered.title, rendered.body, null, null, { sender: "support", event: `notify.${event.kind}` });
        return "outbox_queued";
      });
    } else if (ch === "sms") {
      // SMS stays gated to the existing transactional/consent engine — no new
      // unrestricted texting. Only kinds with a phone on file ever reach here.
      await recordDelivery(db, nid, "sms", "skipped", "handled_by_sms_engine");
    }
  }

  await db.from("notification_events").update({ status: "done", processed_at: new Date().toISOString() }).eq("id", event.id);
  return "done";
}

/**
 * Emits a notification event: writes the durable outbox row first (throws on
 * failure → the caller's mutation reports the error), then delivers in-band.
 * Due-now pattern matches notification_jobs; the cron sweep retries stragglers.
 */
export async function emit(db: SupabaseClient, input: EmitInput): Promise<void> {
  const dedupe = input.dedupeKey ?? null;
  const { data, error } = await db.from("notification_events").insert({
    profile_id: input.profileId, kind: input.kind,
    vars: { ...(input.vars as Record<string, string> ?? {}), ...(input.deepLink ? { deep_link: input.deepLink } : {}) },
    actor: input.actor ?? null, correlation_id: input.correlationId ?? null, dedupe_key: dedupe,
  }).select("id,profile_id,kind,vars,actor,correlation_id,dedupe_key").maybeSingle();
  if (error) {
    if (error.code === "23505") return; // duplicate dedupe_key — already notified
    throw new Error(`notify_emit_failed: ${error.message.slice(0, 160)}`);
  }
  if (!data) return;
  try { await deliverEvent(db, data as Parameters<typeof deliverEvent>[1]); }
  catch (e) { recordLog("error", "notify_deliver_failed", { service: "notify", attrs: { kind: input.kind, error: e instanceof Error ? e.message.slice(0, 160) : "unknown" } }); }
}

/**
 * Sweeps due notification_events — retries with backoff, marks dead after 5.
 * Called by /api/cron/notifications alongside the SMS sweep.
 */
export async function sweepNotificationEvents(db: SupabaseClient, now = new Date()): Promise<{ done: number; failed: number; dead: number }> {
  const { data } = await db.from("notification_events")
    .select("id,profile_id,kind,vars,actor,correlation_id,dedupe_key,attempts")
    .eq("status", "queued").lte("due_at", now.toISOString()).order("id").limit(50);
  let done = 0, failed = 0, dead = 0;
  for (const ev of (data ?? []) as (Parameters<typeof deliverEvent>[1] & { attempts: number })[]) {
    const r = await deliverEvent(db, ev).catch(() => "failed" as const);
    if (r === "done") { done++; continue; }
    const attempts = (ev.attempts ?? 0) + 1;
    if (attempts >= 5) {
      await db.from("notification_events").update({ status: "dead", attempts }).eq("id", ev.id);
      dead++;
    } else {
      const backoff = new Date(now.getTime() + 2 ** attempts * 60_000);
      await db.from("notification_events").update({ status: "queued", attempts, due_at: backoff.toISOString() }).eq("id", ev.id);
      failed++;
    }
  }
  return { done, failed, dead };
}

/**
 * Writes a persistent in-app notification without the events outbox — for
 * pipelines (notification_jobs sweep, helpdesk) whose own durable rows already
 * ARE the event record. dedupeKey keeps retries/replays from duplicating rows.
 * `deliveries` records which other channels the caller already handled.
 * Returns the notification id, or null on dedupe/failure. Never throws.
 */
export async function recordInApp(db: SupabaseClient, input: {
  profileId: string; category: NotifyCategory; kind: string; title: string; body: string;
  data?: Record<string, string>; dedupeKey: string;
  deliveries?: { channel: NotifyChannel; status: "sent" | "failed" | "skipped" | "deferred"; detail: string }[];
}): Promise<string | null> {
  try {
    const { data, error } = await db.from("notifications")
      .insert({ profile_id: input.profileId, category: input.category, kind: input.kind, title: input.title.slice(0, 160), body: input.body.slice(0, 1000), data: input.data ?? {}, dedupe_key: input.dedupeKey })
      .select("id").maybeSingle();
    if (error || !data) return null;
    const nid = (data as { id: string }).id;
    await recordDelivery(db, nid, "in_app", "sent", "recorded");
    for (const d of input.deliveries ?? []) await recordDelivery(db, nid, d.channel, d.status, d.detail);
    return nid;
  } catch { return null; }
}

/** Convenience for sites that know the customer by email, not profile id. */
export async function emitByEmail(db: SupabaseClient, email: string, input: Omit<EmitInput, "profileId">): Promise<void> {
  const { data: prof } = await db.from("profiles").select("id").ilike("email", email).maybeSingle();
  const pid = (prof as { id: string } | null)?.id;
  if (!pid) return; // guests have no notification center — email path stays the channel
  await emit(db, { ...input, profileId: pid });
}
