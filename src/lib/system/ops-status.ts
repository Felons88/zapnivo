import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient, backendConfigured } from "@/lib/supabase";
import { listIntegrationStatus, type IntegrationRow } from "./integrations";
import { securityReadiness, type BackupState } from "./readiness";
import { kioskAdapterName } from "./kiosks";
import { mailerConfigured } from "@/lib/helpdesk/mailer";
import { MEDIA_BUCKET } from "./site-media";

/**
 * Operations status — per-subsystem integration readiness for the launch
 * dashboard. HONESTY RULES (same contract as launch.ts):
 *
 *  - 'operational' is emitted ONLY when the subsystem is configured AND a cheap
 *    live check just passed (DB probe, recorded provider health check, outbox
 *    evidence). Env-var presence alone never produces 'operational'.
 *  - Provider cards reuse listIntegrationStatus(): the LAST recorded on-demand
 *    health check (system_audit_events) is the verification evidence — we do
 *    not fire live provider calls on every dashboard render.
 *  - DB-backed subsystems are probed with bounded count queries; a failed probe
 *    degrades honestly, a missing backend reports 'not_configured'.
 *  - 'blocked' is reserved for implemented-but-gated subsystems (no kiosk
 *    adapter, no verified backup). 'requires_action' means configured but never
 *    verified, or verification is impossible without a human step.
 */

export type OpsState = "operational" | "degraded" | "not_configured" | "blocked" | "requires_action";

export type OpsCard = {
  id: string;
  label: string;
  state: OpsState;
  /** Code/schema for this subsystem exists in the repo. */
  implemented: boolean;
  /** Required env vars / tables / buckets are present. */
  configured: boolean;
  /** A live or recorded check confirmed it works; null = never verified. */
  verified: boolean | null;
  /** When the underlying evidence was produced (ISO). */
  lastChecked: string;
  /** The single most useful next step, or null when operational. */
  nextAction: string | null;
  /** System Control page that manages this subsystem. */
  href: string;
};

export type OpsStatus = {
  generatedAt: string;
  cards: OpsCard[];
};

const PROVIDER_IDS = ["stripe", "brevo", "twilio", "openrouter", "github", "vercel", "analytics", "alerts"] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  stripe: "Stripe payments",
  brevo: "Brevo email",
  twilio: "Twilio SMS",
  openrouter: "OpenRouter AI",
  github: "GitHub",
  vercel: "Vercel hosting",
  analytics: "Analytics (GTM/GA4/Mapbox)",
  alerts: "Alert delivery webhook",
};

const NEWSLETTER_EVENTS = ["newsletter.confirm", "newsletter.welcome"] as const;

/** Bounded head-count probe; null = table missing/unreachable. */
async function probeTable(db: SupabaseClient, table: string): Promise<number | null> {
  try {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

/** Count of 'sent' newsletter outbox rows — proof the DOI path reached a provider. */
async function sentNewsletterCount(db: SupabaseClient): Promise<number | null> {
  try {
    const { count, error } = await db
      .from("email_outbox")
      .select("id", { count: "exact", head: true })
      .eq("status", "sent")
      .in("event", [...NEWSLETTER_EVENTS]);
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

/** Storage bucket reachability — bounded list probe, failure is honest. */
async function probeBucket(db: SupabaseClient, bucket: string): Promise<boolean> {
  try {
    const { error } = await db.storage.from(bucket).list("", { limit: 1 });
    return !error;
  } catch {
    return false;
  }
}

function card(partial: Omit<OpsCard, "lastChecked"> & { lastChecked?: string }, now: string): OpsCard {
  return { lastChecked: now, ...partial };
}

/** Provider integration card from the recorded registry status. */
function providerCard(row: IntegrationRow | undefined, id: ProviderId, now: string): OpsCard {
  const label = PROVIDER_LABELS[id];
  if (!row) {
    return card({ id, label, state: "not_configured", implemented: true, configured: false, verified: null, nextAction: "Provider missing from integration registry", href: "/system/integrations" }, now);
  }
  const href = "/system/integrations";
  if (!row.configured) {
    return card({
      id, label, state: "not_configured", implemented: true, configured: false, verified: null,
      nextAction: `Set env: ${row.envVars.join(", ") || "(see /system/integrations)"}`, href,
    }, now);
  }
  const hc = row.lastHealthCheck;
  const checkedAt = hc?.checkedAt ?? now;
  switch (hc?.status) {
    case "operational":
      return card({ id, label, state: "operational", implemented: true, configured: true, verified: true, lastChecked: checkedAt, nextAction: null, href }, now);
    case "degraded":
      return card({ id, label, state: "degraded", implemented: true, configured: true, verified: false, lastChecked: checkedAt, nextAction: "Provider check degraded — run a health check on /system/integrations", href }, now);
    case "unknown":
    case "not_verified":
      return card({ id, label, state: "requires_action", implemented: true, configured: true, verified: null, lastChecked: checkedAt, nextAction: "Configured but never verified — run a health check", href }, now);
    case "requires_credentials":
      return card({ id, label, state: "requires_action", implemented: true, configured: true, verified: false, lastChecked: checkedAt, nextAction: "Provider requires credentials — see integration detail", href }, now);
    default:
      // Configured, no recorded check → honest 'requires_action', never 'operational'.
      return card({ id, label, state: "requires_action", implemented: true, configured: true, verified: null, nextAction: "Configured but never verified — run a health check on /system/integrations", href }, now);
  }
}

const BACKUP_STATE_MAP: Record<BackupState, { state: OpsState; verified: boolean | null; nextAction: string | null }> = {
  recovery_verified: { state: "operational", verified: true, nextAction: null },
  restore_tested: { state: "operational", verified: true, nextAction: null },
  restore_pending: { state: "requires_action", verified: false, nextAction: "Restore test in progress — confirm result in /system/recovery" },
  backup_available: { state: "requires_action", verified: false, nextAction: "Backups exist but no restore test recorded — run an isolated restore exercise" },
  backup_configured: { state: "requires_action", verified: false, nextAction: "PITR configured but no listed backup confirmed — verify in Supabase dashboard" },
  no_verified_backup: { state: "blocked", verified: false, nextAction: "No verified backup — enable PITR/scheduled backups, then test a restore" },
};

export async function getOpsStatus(dbOverride?: SupabaseClient | null): Promise<OpsStatus> {
  const db = dbOverride === undefined ? serviceClient() : dbOverride;
  const now = new Date().toISOString();
  const cards: OpsCard[] = [];

  /* ── Provider integrations (recorded health checks only) ─────────────── */
  const integrations = await listIntegrationStatus(db);
  const byId = new Map(integrations.map((r) => [r.id, r]));
  for (const id of PROVIDER_IDS) {
    cards.push(providerCard(byId.get(id), id, now));
  }

  /* ── Newsletter / DOI pipeline ───────────────────────────────────────── */
  {
    const mailer = mailerConfigured();
    const subscribers = db ? await probeTable(db, "newsletter_subscribers") : null;
    const sentCount = db && subscribers !== null ? await sentNewsletterCount(db) : null;
    const configured = Boolean(db) && mailer && subscribers !== null;
    const verified = sentCount !== null && sentCount > 0 ? true : sentCount === null ? null : false;
    let state: OpsState;
    let nextAction: string | null = null;
    if (!db) { state = "not_configured"; nextAction = "Supabase backend not configured"; }
    else if (!mailer) { state = "requires_action"; nextAction = "Set BREVO_API_KEY or RESEND_API_KEY — DOI email queues but never sends"; }
    else if (subscribers === null) { state = "degraded"; nextAction = "newsletter_subscribers table unreachable — check migration 0060"; }
    else if (verified === true) { state = "operational"; }
    else { state = "requires_action"; nextAction = "No sent DOI email on record — send a test DOI from /system/newsletter to verify delivery"; }
    cards.push(card({
      id: "newsletter", label: "Newsletter (DOI email)", state,
      implemented: true, configured, verified, nextAction, href: "/system/newsletter",
    }, now));
  }

  /* ── CMS content ─────────────────────────────────────────────────────── */
  {
    const contentCount = db ? await probeTable(db, "site_content") : null;
    const reachable = contentCount !== null;
    cards.push(card({
      id: "cms", label: "Site CMS", state: !db ? "not_configured" : reachable ? "operational" : "degraded",
      implemented: true, configured: reachable,
      verified: db ? reachable : null,
      nextAction: !db ? "Supabase backend not configured"
        : !reachable ? "site_content table unreachable — check migration 0058"
        : contentCount === 0 ? "Table reachable but empty — publish content via /system/sites" : null,
      href: "/system/sites",
    }, now));
  }

  /* ── Redirects ───────────────────────────────────────────────────────── */
  {
    // Runtime enforcement exists: src/lib/site-redirects.ts (60s-cached rule
    // index) is consumed by src/proxy.ts and issues 307s on public traffic.
    // Cheap live check = the rules table is reachable; per-request fetch
    // failures degrade to "last good cache" inside the reader itself.
    const redirectCount = db ? await probeTable(db, "site_redirects") : null;
    const reachable = redirectCount !== null;
    cards.push(card({
      id: "redirects", label: "Redirect rules", state: !db ? "not_configured" : reachable ? "operational" : "degraded",
      implemented: true, configured: reachable, verified: db ? reachable : null,
      nextAction: !db ? "Supabase backend not configured"
        : !reachable ? "site_redirects table unreachable — check migration 0062"
        : redirectCount === 0 ? "No redirect rules defined — add via /system/sites/ops if needed" : null,
      href: "/system/sites/ops",
    }, now));
  }

  /* ── Media library ───────────────────────────────────────────────────── */
  {
    const mediaCount = db ? await probeTable(db, "site_media") : null;
    const bucketOk = db ? await probeBucket(db, MEDIA_BUCKET) : false;
    const reachable = mediaCount !== null;
    const ok = reachable && bucketOk;
    cards.push(card({
      id: "media", label: "Media library", state: !db ? "not_configured" : ok ? "operational" : "degraded",
      implemented: true, configured: ok, verified: db ? ok : null,
      nextAction: !db ? "Supabase backend not configured"
        : !reachable ? "site_media table unreachable — check migration 0061"
        : !bucketOk ? `Storage bucket '${MEDIA_BUCKET}' unreachable` : null,
      href: "/system/sites",
    }, now));
  }

  /* ── Backup & recovery (reuse the readiness state machine) ───────────── */
  {
    const readiness = await securityReadiness(db);
    const mapped = BACKUP_STATE_MAP[readiness.backup.state] ?? BACKUP_STATE_MAP.no_verified_backup;
    cards.push(card({
      id: "recovery", label: "Backup & recovery", state: mapped.state,
      implemented: true, configured: readiness.configured, verified: mapped.verified,
      lastChecked: readiness.generated_at,
      nextAction: mapped.nextAction, href: "/system/recovery",
    }, now));
  }

  /* ── Kiosk hardware adapter ──────────────────────────────────────────── */
  {
    const adapter = kioskAdapterName();
    const configured = adapter !== "none";
    cards.push(card({
      id: "kiosk_adapter", label: "Kiosk hardware adapter", state: configured ? "requires_action" : "blocked",
      implemented: true, configured, verified: false,
      nextAction: configured
        ? `KIOSK_ADAPTER=${adapter} configured but no physical device has been verified`
        : "KIOSK_ADAPTER=none — no hardware path exists; requires real kiosk hardware + vendor docs",
      href: "/system/kiosks",
    }, now));
  }

  return { generatedAt: now, cards };
}
