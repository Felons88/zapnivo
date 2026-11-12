import type { SupabaseClient } from "@supabase/supabase-js";
import { renderEmail } from "./email-templates";
import { flushOutbox, getMailer } from "./helpdesk/mailer";
import { getRepo } from "./helpdesk/repo";
import { expireStaleCommands, sweepStaleCommands } from "./kiosk/commands";
import { HEARTBEAT_STALE_MIN } from "./kiosk/heartbeat";
import { subUrl } from "./site";
import { newTraceId, traced } from "./observability";

const OFFLINE_AFTER_MIN = HEARTBEAT_STALE_MIN;
const LOW_BATTERY_PCT = 15;
type Pref = "offline_alerts" | "low_battery_alerts" | "new_partner_inquiries";

/** Staff who should receive a given alert (default on when they never saved prefs). */
export async function staffRecipients(db: SupabaseClient, pref: Pref): Promise<string[]> {
  const { data: staff } = await db.from("profiles").select("id,email").in("role", ["admin", "staff"]).limit(200);
  const { data: prefs } = await db.from("notification_prefs").select(`profile_id,${pref}`).limit(200);
  const off = new Set(((prefs ?? []) as unknown as Record<string, unknown>[]).filter((p) => p[pref] === false).map((p) => String(p.profile_id)));
  return ((staff ?? []) as { id: string; email: string }[]).filter((s) => !off.has(s.id)).map((s) => s.email);
}

export async function alertStaff(db: SupabaseClient, pref: Pref, subject: string, body: string, html: string | null = null, meta: { sender?: string | null; template?: string | null; event?: string | null } = {}) {
  const repo = await getRepo();
  if (!repo) return 0;
  const to = await staffRecipients(db, pref);
  for (const t of to) await repo.queueEmail({ ticketId: null, to: t, subject, body, html, sender: meta.sender ?? null, replyTo: null, template: meta.template ?? null, event: meta.event ?? null });
  if (to.length) await flushOutbox(repo, getMailer());
  return to.length;
}

/** Marks silent stations offline and alerts staff once per outage; flags low batteries; expires dead commands. */
export async function runFleetSweep(db: SupabaseClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - OFFLINE_AFTER_MIN * 60_000).toISOString();
  const { data: stale } = await db.from("kiosks").select("id,station_id,last_seen_at,venues(name,city)")
    .eq("state", "online").lt("last_seen_at", cutoff).is("offline_alerted_at", null);
  const stations = (stale ?? []) as unknown as { id: string; station_id: string; last_seen_at: string | null; venues: { name: string; city: string | null } | { name: string; city: string | null }[] | null }[];
  for (const k of stations) await db.from("kiosks").update({ state: "offline", offline_alerted_at: now.toISOString() }).eq("id", k.id);
  if (stations.length) {
    const lines = stations.map((k) => { const v = Array.isArray(k.venues) ? k.venues[0] : k.venues; return `• ${k.station_id}${v ? ` (${v.name})` : ""} — last seen ${k.last_seen_at ?? "never"}`; });
    const venueOf = (k: (typeof stations)[number]) => { const v = Array.isArray(k.venues) ? k.venues[0] : k.venues; return v ?? null; };
    const detected = now.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    const html = stations.length === 1
      ? renderEmail("station_offline", {
          station_id: stations[0].station_id,
          station_name: venueOf(stations[0])?.name ?? stations[0].station_id,
          venue_name: venueOf(stations[0])?.name ?? "—",
          city: venueOf(stations[0])?.city ?? "—",
          detected_at: detected, admin_url: subUrl("internal", "/fleet"), year: String(now.getFullYear()),
        })
      : renderEmail("station_offline", {
          station_id: "fleet", station_name: `${stations.length} stations`, venue_name: "Multiple venues",
          city: "—", detected_at: detected, admin_url: subUrl("internal", "/fleet"), year: String(now.getFullYear()),
        });
    await alertStaff(db, "offline_alerts", `${stations.length} station${stations.length === 1 ? "" : "s"} offline`, `No heartbeat for ${OFFLINE_AFTER_MIN}+ minutes:\n\n${lines.join("\n")}\n\nFleet: ${subUrl("internal", "/fleet")}`, html, { sender: "operations", template: "station_offline", event: "station.offline" });
  }

  const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const { data: low } = await db.from("power_banks").select("id,serial,battery_pct,low_battery_alerted_at")
    .eq("retired", false).lt("battery_pct", LOW_BATTERY_PCT).or(`low_battery_alerted_at.is.null,low_battery_alerted_at.lt.${dayAgo}`).limit(200);
  const banks = (low ?? []) as { id: string; serial: string; battery_pct: number }[];
  if (banks.length) {
    await db.from("power_banks").update({ low_battery_alerted_at: now.toISOString() }).in("id", banks.map((b) => b.id));
    await alertStaff(db, "low_battery_alerts", `${banks.length} power bank${banks.length === 1 ? "" : "s"} below ${LOW_BATTERY_PCT}%`, banks.map((b) => `• ${b.serial} — ${b.battery_pct}%`).join("\n"), null, { sender: "operations", event: "station.low_battery" });
  }

  const expired = await expireStaleCommands(db, now);
  // Phase 2.5: open commands past expires_at → unknown_outcome (a lost ack is
  // not a failed dispense) + rental_exceptions for linked rentals.
  const staleCommands = await sweepStaleCommands(db, now);
  return { offline: stations.length, lowBattery: banks.length, expiredCommands: expired, staleCommands };
}

/** Records a cron run and emails staff if it failed — so a broken sweep is never silent. */
export async function recordCron(db: SupabaseClient, job: string, run: () => Promise<Record<string, unknown>>) {
  try {
    // Span per cron job so trace_spans correlate with the cron_runs row written below.
    const detail = await traced(`cron.${job}`, newTraceId(), run, { job });
    await db.from("cron_runs").insert({ job, ok: true, detail });
    return { ok: true as const, detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    await db.from("cron_runs").insert({ job, ok: false, detail: { error: msg } });
    await alertStaff(db, "offline_alerts", `Cron job failed: ${job}`, `The ${job} job failed: ${msg}\n\nCheck runtime logs in Vercel.`, null, { sender: "admin", event: "admin.cron_failed" }).catch(() => 0);
    return { ok: false as const, detail: { error: msg } };
  }
}
