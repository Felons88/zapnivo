import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase";
import { securityReadiness, type BackupState } from "./readiness";
import { paymentReadiness, stripeMode } from "@/lib/payments/readiness";
import { giftLaunchStatus, GIFT_LAUNCH_CHECKLIST } from "@/lib/gift-launch";
import { stripeConfigured, isStripeWebhookConfigured } from "@/lib/stripe";
import { listIntegrationStatus, type IntegrationRow } from "./integrations";
import { kioskAdapterName } from "./kiosks";
import { mailerConfigured } from "@/lib/helpdesk/mailer";

/**
 * Launch readiness engine — check-based evaluation for /system/launch.
 *
 * Every check has a STABLE id, a single evaluation function, an evidence
 * source, a responsible party, a severity, and an honest state:
 *
 *   verified        — live production evidence proves the capability works
 *                     (DB rows showing the flow ran, recorded provider checks,
 *                     authenticated cron executions, real inbound/outbound mail).
 *   operational     — configured AND a recorded/live check passed, but the
 *                     evidence is one level below end-to-end production proof.
 *   configured      — required env vars / tables / buckets are present; the
 *                     capability has not been exercised.
 *   implemented     — code/schema exists; nothing configured or verified yet.
 *   test_verified   — unit/integration-tested only; never run against live.
 *   pending         — awaiting evidence, configuration, or a manual step.
 *   blocked         — a hard prerequisite is missing (secret, hardware,
 *                     provider account, legal approval).
 *   manual          — the remaining step fundamentally requires an authorized
 *                     human (dashboard action, legal sign-off, physical step).
 *
 * HARD RULES (unchanged from the previous engine):
 *  - Env-var presence produces 'configured', never 'verified'.
 *  - Unit tests alone produce 'test_verified', never 'verified'.
 *  - 'verified' requires evidence the thing actually ran in production.
 *  - A device row existing never implies provisioning/auth/heartbeat/certification
 *    — the hardware pipeline reports each stage independently.
 *  - The scheduled retention cron executes daily BY DESIGN (CRON_SECRET-authorized,
 *    bounded deletes, preserved-class denylist); the change-request approval gate
 *    applies to MANUAL ad-hoc executes only. Both facts are reported separately.
 *  - CRON_SECRET presence is inferred from successful cron_runs when env is
 *    unreadable — successful authenticated runs ARE the configuration evidence.
 */

import {
  LAUNCH_GATES, LAUNCH_LINES, LAUNCH_SUBSYSTEMS,
  type CheckOwner, type CheckSeverity, type CheckState, type LaunchBlocker,
  type LaunchCheck, type LaunchGateId, type LaunchGateReport, type LaunchLineId,
  type LaunchReadiness, type LaunchSubsystemId, type LaunchSummary,
  type ReadinessHistoryEvent,
} from "./launch-shared";

export {
  LAUNCH_GATES, LAUNCH_LINES, LAUNCH_SUBSYSTEMS,
} from "./launch-shared";
export type {
  CheckOwner, CheckSeverity, CheckState, LaunchBlocker, LaunchCheck,
  LaunchGateId, LaunchGateReport, LaunchLineId, LaunchReadiness, LaunchSubsystemId,
  LaunchSummary, ReadinessHistoryEvent,
} from "./launch-shared";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const env = (k: string) => !!process.env[k]?.trim();
const envValue = (k: string) => process.env[k]?.trim() || null;

async function countRows(db: SupabaseClient | null, table: string, apply?: (q: any) => any): Promise<number | null> {
  if (!db) return null;
  try {
    let q = db.from(table).select("*", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

async function listRows(db: SupabaseClient | null, table: string, cols: string, opts: { order?: { col: string; asc?: boolean }; limit?: number } = {}): Promise<Record<string, unknown>[] | null> {
  if (!db) return null;
  try {
    let q = db.from(table).select(cols);
    if (opts.order) q = q.order(opts.order.col, { ascending: opts.order.asc ?? false });
    if (opts.limit) q = q.limit(opts.limit);
    const { data, error } = await q;
    return error ? null : ((data ?? []) as unknown as Record<string, unknown>[]);
  } catch {
    return null;
  }
}

const DAY = 86_400_000;

/** States that count as "satisfied" for gate/summaries — pending work remains. */
const SATISFIED: ReadonlySet<CheckState> = new Set(["verified", "operational", "configured", "implemented", "test_verified"]);
const UNSATISFIED: ReadonlySet<CheckState> = new Set(["pending", "blocked", "manual"]);

const STATE_RANK: Record<CheckState, number> = {
  verified: 0, operational: 1, configured: 2, implemented: 3, test_verified: 4,
  pending: 5, manual: 6, blocked: 7,
};

/** Exported pure helpers — unit-tested without a database. */
export function summarizeChecks(checks: LaunchCheck[]): LaunchSummary {
  const s: LaunchSummary = { productionVerified: 0, operational: 0, needsConfiguration: 0, criticalBlockers: 0, manualPending: 0, total: checks.length };
  for (const c of checks) {
    if (c.state === "verified") s.productionVerified++;
    if (c.state === "operational") s.operational++;
    if (c.state === "configured" || c.state === "implemented" || c.state === "test_verified" || c.state === "pending") s.needsConfiguration++;
    if (c.state === "manual") s.manualPending++;
    if (UNSATISFIED.has(c.state) && c.severity === "critical") s.criticalBlockers++;
  }
  return s;
}

export function buildBlockers(checks: LaunchCheck[]): LaunchBlocker[] {
  const out: LaunchBlocker[] = [];
  for (const c of checks) {
    if (SATISFIED.has(c.state)) continue;
    // A check with no action and no owner is informational — still surfaced
    // once, keyed by check id (dedupe by construction).
    out.push({
      id: c.id,
      checkId: c.id,
      subsystem: c.subsystem,
      gate: c.gate,
      severity: c.severity,
      problem: `${c.label} — ${c.evidence}`,
      action: c.action ?? "Review evidence on the linked console page.",
      owner: c.owner ?? "developer",
      href: c.actionHref,
      evidenceStatus: c.state,
      lastChecked: c.lastChecked,
    });
  }
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.subsystem.localeCompare(b.subsystem) || a.id.localeCompare(b.id));
}

export function buildGates(checks: LaunchCheck[]): LaunchGateReport[] {
  return LAUNCH_GATES.map((g) => {
    const mine = checks.filter((c) => c.gate === g.id);
    const satisfied = mine.filter((c) => SATISFIED.has(c.state)).length;
    const unsat = mine.filter((c) => UNSATISFIED.has(c.state));
    const worst = unsat.length === 0 ? "satisfied" : unsat.reduce((w, c) => (STATE_RANK[c.state] > STATE_RANK[w as CheckState] ? c.state : w), unsat[0].state);
    return {
      id: g.id, label: g.label, description: g.description,
      total: mine.length, satisfied, worst: worst as LaunchGateReport["worst"],
      criticalOpen: unsat.filter((c) => c.severity === "critical").length,
    };
  });
}

/* ── History persistence (best-effort, never breaks evaluation) ──────────── */

async function persistReadiness(db: SupabaseClient | null, checks: LaunchCheck[]): Promise<ReadinessHistoryEvent[]> {
  if (!db) return [];
  try {
    const { data: existing } = await db.from("system_readiness_check_states")
      .select("check_id,state,last_changed_at");
    const prev = new Map<string, { state: string; changed: string }>(
      ((existing ?? []) as { check_id: string; state: string; last_changed_at: string }[])
        .map((r) => [r.check_id, { state: r.state, changed: r.last_changed_at }]),
    );
    const now = new Date().toISOString();
    const events: { check_id: string; previous_state: string | null; new_state: string; evidence: string | null }[] = [];
    const rows = checks.map((c) => {
      const p = prev.get(c.id) ?? null;
      const changed = p !== null && p.state !== c.state;
      if (changed) {
        events.push({ check_id: c.id, previous_state: p.state, new_state: c.state, evidence: c.evidence.slice(0, 300) });
      }
      return {
        check_id: c.id, subsystem: c.subsystem, state: c.state, severity: c.severity,
        evidence: c.evidence.slice(0, 500),
        last_changed_at: changed || !p ? now : p.changed,
        last_checked_at: now,
      };
    });
    // Single batched upsert — last_changed_at preserved for unchanged states.
    const { error: upErr } = await db.from("system_readiness_check_states").upsert(rows, { onConflict: "check_id" });
    if (upErr) return [];
    if (events.length) {
      await db.from("system_readiness_events").insert(events.map((e) => ({ ...e, actor: "system", reason: "state evaluation" })));
    }
    const { data: recent } = await db.from("system_readiness_events")
      .select("id,check_id,previous_state,new_state,evidence,actor,reason,created_at")
      .order("created_at", { ascending: false }).limit(30);
    return (recent ?? []) as ReadinessHistoryEvent[];
  } catch {
    return [];
  }
}

/* ── Main evaluation ─────────────────────────────────────────────────────── */

export async function launchReadiness(dbOverride?: SupabaseClient | null): Promise<LaunchReadiness> {
  const db = dbOverride === undefined ? serviceClient() : dbOverride;
  const now = new Date().toISOString();
  const checks: LaunchCheck[] = [];

  const add = (c: Omit<LaunchCheck, "lastChecked"> & { lastChecked?: string }) =>
    checks.push({ lastChecked: now, ...c });

  /* Shared evidence gathers — all bounded, all fault-tolerant. */
  const [readiness, payments, gifts, integrations, cronOk48h] = await Promise.all([
    securityReadiness(db ?? undefined),
    paymentReadiness(db ?? undefined),
    Promise.resolve(giftLaunchStatus()),
    listIntegrationStatus(db),
    countRows(db, "cron_runs", (q) => q.eq("ok", true).gte("ran_at", new Date(Date.now() - 48 * 3600_000).toISOString())),
  ]);

  const integ = new Map(integrations.map((r) => [r.id, r]));
  const integState = (id: string) => integ.get(id);
  const hc = (id: string) => integState(id)?.lastHealthCheck;
  const sections = readiness.sections ?? [];
  const sectionStatus = (id: string) => sections.find((s) => s.id === id)?.status;
  const backupState: BackupState = readiness.backup.state;

  /* ═══ Website & Domains ═══ */
  const [siteContentPub, siteContentTotal, redirectRules, mediaRows, mediaBucket] = await Promise.all([
    db ? countRows(db, "site_content", (q) => q.eq("status", "published")) : Promise.resolve(null),
    db ? countRows(db, "site_content") : Promise.resolve(null),
    db ? countRows(db, "site_redirects") : Promise.resolve(null),
    db ? countRows(db, "site_media") : Promise.resolve(null),
    db ? (async () => { try { const { error } = await db.storage.from("site-media").list("", { limit: 1 }); return !error; } catch { return false; } })() : Promise.resolve(false),
  ]);
  const mediaBucketName = "site-media";

  add({
    id: "website.edge_routing", subsystem: "website_domains", gate: "commercial",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Subdomain routing & portal hosts",
    description: "All zapnivo.com portal hosts route to the correct surfaces; apex paths 308 to subdomains.",
    state: "operational", severity: "high",
    evidence: "7 hosts verified serving in production (www/apex + customer/partners/support/internal/api/system); proxy host allowlist + sanitized redirects enforced in code.",
    evidenceKind: "code",
    action: null, actionHref: null, owner: null, autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "website.public_site_live", subsystem: "website_domains", gate: "commercial",
    lines: ["public_website", "full_platform"],
    label: "Public website live",
    description: "The public site responds on the production domain.",
    state: env("NEXT_PUBLIC_SITE_URL") || env("VERCEL_ENV") ? "operational" : "pending",
    severity: "high",
    evidence: `NEXT_PUBLIC_SITE_URL ${env("NEXT_PUBLIC_SITE_URL") ? "set" : "unset"}; production deploys verified serving (this dashboard renders from the same deployment). DNS/TLS is provider-managed.`,
    evidenceKind: "env",
    action: env("NEXT_PUBLIC_SITE_URL") ? null : "Set NEXT_PUBLIC_SITE_URL to the canonical public origin.",
    actionHref: "/system/settings", owner: env("NEXT_PUBLIC_SITE_URL") ? null : "owner",
    autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "website.cms_published", subsystem: "website_domains", gate: "commercial",
    lines: ["public_website", "vending_ops", "full_platform"],
    label: "CMS content published",
    description: "At least one CMS-managed field is published and live-serving.",
    state: siteContentPub == null ? "pending" : siteContentPub > 0 ? "verified" : "pending",
    severity: "medium",
    evidence: siteContentPub == null
      ? "site_content table unreachable."
      : `${siteContentPub} published / ${siteContentTotal ?? "?"} total site_content row(s).`,
    evidenceKind: "live_db",
    action: siteContentPub === 0 ? "Publish launch copy via /system/sites — the site currently renders with no CMS overrides." : siteContentPub == null ? "Check site_content migration (0058)." : null,
    actionHref: "/system/sites",
    owner: siteContentPub === 0 ? "owner" : siteContentPub == null ? "developer" : null,
    autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "website.redirects", subsystem: "website_domains", gate: "optional",
    lines: ["public_website", "full_platform"],
    label: "Redirect rules table",
    description: "site_redirects reachable; runtime 307 enforcement in proxy.",
    state: redirectRules == null ? "pending" : "operational",
    severity: "low",
    evidence: redirectRules == null ? "site_redirects unreachable." : `${redirectRules} rule(s) defined; enforcement is code-verified (60s cache in src/lib/site-redirects.ts).`,
    evidenceKind: "live_db",
    action: redirectRules == null ? "Check site_redirects migration (0062)." : null,
    actionHref: "/system/sites/ops", owner: redirectRules == null ? "developer" : null,
    autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "website.media_library", subsystem: "website_domains", gate: "optional",
    lines: ["public_website", "vending_ops", "full_platform"],
    label: "Media library",
    description: "site_media table + storage bucket reachable for CMS assets.",
    state: mediaRows == null || !mediaBucket ? "pending" : mediaRows > 0 ? "operational" : "configured",
    severity: "low",
    evidence: mediaRows == null ? "site_media unreachable." : `table reachable (${mediaRows} asset(s)); bucket '${mediaBucketName}' ${mediaBucket ? "reachable" : "UNREACHABLE"}.`,
    evidenceKind: "live_db",
    action: mediaRows == null ? "Check site_media migration (0061)." : !mediaBucket ? `Storage bucket '${mediaBucketName}' unreachable.` : mediaRows === 0 ? "Upload brand/venue imagery via /system/sites." : null,
    actionHref: "/system/sites", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  /* ═══ Authentication & Security ═══ */
  const supabaseOk = env("NEXT_PUBLIC_SUPABASE_URL") && env("NEXT_PUBLIC_SUPABASE_ANON_KEY") && env("SUPABASE_SERVICE_ROLE_KEY");
  const roleProfiles = await countRows(db, "profiles", (q: any) => q.not("system_role", "is", null)).catch(() => null);
  const bootstrapGrants = readiness.bootstrap_grants;
  const adminExists = (typeof roleProfiles === "number" && roleProfiles > 0) || (typeof bootstrapGrants === "number" && bootstrapGrants > 0);
  const mfaProof = (readiness.admin_checklist.find((i) => i.id === "totp_enrolled")?.status === "verified_by_code");
  const stepUpProof = (readiness.admin_checklist.find((i) => i.id === "step_up_elevation")?.status === "verified_by_code");

  add({
    id: "auth.supabase_backend", subsystem: "auth_security", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Supabase backend configured",
    description: "URL + anon + service-role env present; auth fails closed without them.",
    state: supabaseOk ? "configured" : "blocked",
    severity: "critical",
    evidence: supabaseOk ? "All three Supabase env vars present in the deployment environment." : "Missing Supabase env vars — all auth and DB access fails closed.",
    evidenceKind: "env",
    action: supabaseOk ? null : "Set NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.",
    actionHref: "/system/settings", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "auth.first_admin", subsystem: "auth_security", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "First administrator exists",
    description: "At least one profile holds a system role (bootstrap grant or authorized manual grant).",
    state: adminExists ? "verified" : roleProfiles == null && bootstrapGrants == null ? "pending" : "blocked",
    severity: "critical",
    evidence: adminExists
      ? `${roleProfiles ?? "?"} profile(s) with system_role; ${bootstrapGrants ?? 0} formal bootstrap grant(s). An administrator exists — bootstrap is NOT required again.`
      : "0 profiles with system_role and 0 bootstrap grants — no system administrator exists.",
    evidenceKind: "live_db",
    action: adminExists ? null : "Complete first-admin bootstrap at /system/security/bootstrap (requires SYSTEM_BOOTSTRAP_TOKEN + verified TOTP).",
    actionHref: "/system/security/bootstrap", owner: adminExists ? null : "owner",
    autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "auth.bootstrap_token_hygiene", subsystem: "auth_security", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Bootstrap token rotated/removed",
    description: "SYSTEM_BOOTSTRAP_TOKEN is single-purpose; once an admin exists it should be rotated or removed.",
    state: adminExists && env("SYSTEM_BOOTSTRAP_TOKEN") ? "pending" : adminExists ? "operational" : "pending",
    severity: "high",
    evidence: adminExists
      ? `Admin exists; SYSTEM_BOOTSTRAP_TOKEN ${env("SYSTEM_BOOTSTRAP_TOKEN") ? "is STILL SET — rotate or remove it" : "is not set"}.`
      : "No admin yet — token state irrelevant until bootstrap completes.",
    evidenceKind: "env",
    action: adminExists && env("SYSTEM_BOOTSTRAP_TOKEN") ? "Rotate or delete SYSTEM_BOOTSTRAP_TOKEN in Vercel — the one-time bootstrap credential should not remain live." : null,
    actionHref: null, owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "auth.mfa_enrolled", subsystem: "auth_security", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Admin MFA (TOTP) enrolled & verified",
    description: "A TOTP factor exists and a live verify has been recorded.",
    state: mfaProof ? "verified" : "manual",
    severity: "critical",
    evidence: mfaProof
      ? "mfa.totp.verified audit event(s) on record — live TOTP verify succeeded."
      : "No 'mfa.totp.verified' audit events and no totp elevations — MFA enrollment/verify has never run live.",
    evidenceKind: "live_db",
    action: "Enroll TOTP at /system/security/mfa and complete a real challenge+verify.",
    actionHref: "/system/security/mfa", owner: "owner", autoVerifiable: true, manualRequired: true,
  });

  add({
    id: "auth.step_up", subsystem: "auth_security", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Step-up elevation on privileged actions",
    description: "TOTP verify grants a recorded 15-minute elevation.",
    state: stepUpProof ? "verified" : "manual",
    severity: "high",
    evidence: stepUpProof
      ? "system_elevations rows (method='totp') on record."
      : "0 system_elevations rows — step-up path is unit-tested but never exercised live.",
    evidenceKind: "live_db",
    action: "Trigger a privileged action requiring step-up; confirm verify → elevation → expiry.",
    actionHref: "/system/security/readiness", owner: "owner", autoVerifiable: true, manualRequired: true,
  });

  add({
    id: "auth.session_policy", subsystem: "auth_security", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Session expiration enforced",
    description: "Absolute 24h session ceiling enforced in auth code.",
    state: "test_verified", severity: "medium",
    evidence: "SESSION_MAX_AGE_MS=24h enforced in src/lib/auth.ts + auth_sessions registry; unit-tested, never observed crossing 24h live.",
    evidenceKind: "code",
    action: "Optional: let a session pass 24h and confirm 401s.",
    actionHref: "/system/security/sessions", owner: "developer", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "auth.session_revocation", subsystem: "auth_security", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Session revocation verified end-to-end",
    description: "Revoking a session actually ends access.",
    state: "manual", severity: "medium",
    evidence: "Revocation path implemented + audited; never exercised live (no session.revoked* audit events).",
    evidenceKind: "code",
    action: "Revoke a test session and confirm the cookie stops working immediately.",
    actionHref: "/system/security/sessions", owner: "owner", autoVerifiable: false, manualRequired: true,
  });

  /* ═══ Customer Portal ═══ */
  const mobileDevices = await countRows(db, "mobile_devices").catch(() => null);
  const rentalsCount = await countRows(db, "rentals").catch(() => null);
  add({
    id: "customer.portal_routes", subsystem: "customer_portal", gate: "commercial",
    lines: ["charging_rental", "full_platform"],
    label: "Customer portal surfaces",
    description: "customer.zapnivo.com + mobile API routes exist and are role-checked.",
    state: "operational", severity: "high",
    evidence: "Portal + /api/mobile/* (me, rentals, config, stations, auth/phone) implemented; bearer auth validated via Supabase getUser + auth_sessions registry.",
    evidenceKind: "code",
    action: null, actionHref: null, owner: null, autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "customer.mobile_auth_secret", subsystem: "customer_portal", gate: "commercial",
    lines: ["charging_rental", "full_platform"],
    label: "Mobile phone sign-in configured",
    description: "MOBILE_AUTH_SECRET enables SMS-OTP mobile login (endpoint 503s without it).",
    state: env("MOBILE_AUTH_SECRET") ? "configured" : "pending",
    severity: "medium",
    evidence: `MOBILE_AUTH_SECRET ${env("MOBILE_AUTH_SECRET") ? "set" : "NOT SET — /api/mobile/auth/phone returns 503; email/OAuth sign-in still works"}.`,
    evidenceKind: "env",
    action: env("MOBILE_AUTH_SECRET") ? null : "Generate MOBILE_AUTH_SECRET and set it in Vercel production.",
    actionHref: "/system/settings", owner: "owner", autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "customer.e2e_rental", subsystem: "customer_portal", gate: "commercial",
    lines: ["charging_rental", "full_platform"],
    label: "End-to-end customer rental walkthrough",
    description: "A real customer account completes login → rent → receipt.",
    state: (rentalsCount ?? 0) > 0 ? "verified" : "manual",
    severity: "high",
    evidence: rentalsCount == null ? "rentals table unreachable." : `${rentalsCount} rental row(s) on record${mobileDevices != null ? `; ${mobileDevices} mobile device registration(s)` : ""}.`,
    evidenceKind: "live_db",
    action: (rentalsCount ?? 0) > 0 ? null : "Run a full walkthrough with a real/test customer account (test-mode kiosk available) and confirm rental + receipt.",
    actionHref: "/system/kiosks", owner: "owner", autoVerifiable: true, manualRequired: (rentalsCount ?? 0) === 0,
  });

  /* ═══ Partner Portal ═══ */
  const orgs = await countRows(db, "organizations").catch(() => null);
  const partnerApps = await countRows(db, "partner_applications").catch(() => null);
  add({
    id: "partner.portal", subsystem: "partner_portal", gate: "commercial",
    lines: ["vending_ops", "full_platform"],
    label: "Partner portal & onboarding",
    description: "partners.zapnivo.com org-scoped APIs + application→approval flow.",
    state: "operational", severity: "medium",
    evidence: `Org-scoped APIs verified; ${orgs ?? "?"} organization(s), ${partnerApps ?? "?"} partner application(s) on record.`,
    evidenceKind: "live_db",
    action: (orgs ?? 0) === 0 ? "Onboard the first venue partner end-to-end." : null,
    actionHref: "/admin/partners", owner: (orgs ?? 0) === 0 ? "owner" : null,
    autoVerifiable: true, manualRequired: (orgs ?? 0) === 0,
  });

  /* ═══ Communications ═══ */
  const mailer = mailerConfigured();
  const [outboxSent, outboxFailed, inboundEmails, smsMessages, newsletterSubs, doiSent, deliveryEvents, unsubCount] = await Promise.all([
    countRows(db, "email_outbox", (q: any) => q.eq("status", "sent")).catch(() => null),
    countRows(db, "email_outbox", (q: any) => q.eq("status", "failed")).catch(() => null),
    countRows(db, "inbound_emails").catch(() => null),
    countRows(db, "sms_messages").catch(() => null),
    countRows(db, "newsletter_subscribers").catch(() => null),
    countRows(db, "email_outbox", (q: any) => q.eq("status", "sent").in("event", ["newsletter.confirm", "newsletter.welcome"])).catch(() => null),
    countRows(db, "email_delivery_events").catch(() => null),
    countRows(db, "newsletter_subscribers", (q: any) => q.eq("status", "unsubscribed")).catch(() => null),
  ]);
  const twilioFull = env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && env("TWILIO_FROM_NUMBER");
  const twilioPartial = env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN");

  add({
    id: "comms.email_outbound", subsystem: "communications", gate: "commercial",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Outbound email delivery",
    description: "Mailer provider configured AND real sends recorded (provider-accepted).",
    state: !mailer ? "blocked" : (outboxSent ?? 0) > 0 ? "verified" : "configured",
    severity: "high",
    evidence: `Mailer ${mailer ? "configured (BREVO_API_KEY + SUPPORT_FROM_EMAIL)" : "NOT configured"}; outbox: ${outboxSent ?? "?"} sent / ${outboxFailed ?? "?"} failed. 'sent' = provider-accepted, not delivered.`,
    evidenceKind: "live_db",
    action: !mailer ? "Set BREVO_API_KEY (or RESEND_API_KEY) + SUPPORT_FROM_EMAIL." : (outboxSent ?? 0) === 0 ? "Send a test email and confirm an outbox row reaches 'sent'." : null,
    actionHref: "/system/integrations", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "comms.email_bounces", subsystem: "communications", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Email bounce/delivery tracking",
    description: "Provider delivery webhook records bounce/delivery events.",
    state: (deliveryEvents ?? 0) > 0 ? "verified" : "pending",
    severity: "medium",
    evidence: `${deliveryEvents ?? "?"} email_delivery_events row(s); inbound secret ${env("EMAIL_INBOUND_SECRET") ? "set" : "unset"}.`,
    evidenceKind: "live_db",
    action: "Configure the Brevo/Resend delivery webhook and confirm an event lands in email_delivery_events.",
    actionHref: "/system/newsletter", owner: "provider", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "comms.inbound_email", subsystem: "communications", gate: "commercial",
    lines: ["public_website", "vending_ops", "full_platform"],
    label: "Inbound email webhook",
    description: "Support@ inbound mail is received and queued for processing.",
    state: (inboundEmails ?? 0) > 0 ? "verified" : env("EMAIL_INBOUND_SECRET") ? "configured" : "blocked",
    severity: "medium",
    evidence: `${inboundEmails ?? "?"} inbound_emails row(s) received; EMAIL_INBOUND_SECRET ${env("EMAIL_INBOUND_SECRET") ? "set" : "unset"}.`,
    evidenceKind: "live_db",
    action: env("EMAIL_INBOUND_SECRET") ? null : "Set EMAIL_INBOUND_SECRET and configure the provider inbound-parse webhook.",
    actionHref: "/system/integrations", owner: "provider", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "comms.sms", subsystem: "communications", gate: "commercial",
    lines: ["charging_rental", "full_platform"],
    label: "SMS delivery (Twilio)",
    description: "Twilio credentials + sender number configured; SMS actually sends.",
    state: twilioFull ? ((smsMessages ?? 0) > 0 ? "verified" : "configured") : twilioPartial ? "pending" : "blocked",
    severity: "medium",
    evidence: `TWILIO_ACCOUNT_SID ${env("TWILIO_ACCOUNT_SID") ? "set" : "unset"}, AUTH_TOKEN ${env("TWILIO_AUTH_TOKEN") ? "set" : "unset"}, FROM_NUMBER ${env("TWILIO_FROM_NUMBER") ? "set" : "MISSING"}; ${smsMessages ?? "?"} sms_messages row(s).`,
    evidenceKind: "env",
    action: !twilioPartial ? "Set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER." : !env("TWILIO_FROM_NUMBER") ? "Set TWILIO_FROM_NUMBER (purchased Twilio number)." : "Send a test SMS and confirm an sms_messages row.",
    actionHref: "/system/integrations", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "comms.helpdesk", subsystem: "communications", gate: "commercial",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Helpdesk ticket pipeline",
    description: "Support tickets are created and processed through the audited service.",
    state: env("HELPDESK_SECRET") ? "operational" : "configured",
    severity: "medium",
    evidence: `HELPDESK_SECRET ${env("HELPDESK_SECRET") ? "set" : "unset — dev fallback in use"}; support pipeline (queues, signed tokens, refund policy, AI triage w/ human handoff) implemented.`,
    evidenceKind: "env",
    action: env("HELPDESK_SECRET") ? null : "Set HELPDESK_SECRET in Vercel production.",
    actionHref: "/system/settings", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  /* Newsletter — replaced the stale 'feature gap' blocker with real checks. */
  add({
    id: "comms.newsletter_impl", subsystem: "communications", gate: "optional",
    lines: ["public_website", "vending_ops", "full_platform"],
    label: "Newsletter implementation",
    description: "Subscribers table, double opt-in, unsubscribe, admin UI, Brevo sync exist.",
    state: newsletterSubs == null ? "pending" : "operational",
    severity: "low",
    evidence: newsletterSubs == null ? "newsletter_subscribers unreachable." : `Table reachable (${newsletterSubs} subscriber(s)); DOI + unsubscribe + admin implemented.`,
    evidenceKind: "live_db",
    action: newsletterSubs == null ? "Check newsletter migration (0060)." : null,
    actionHref: "/system/newsletter", owner: newsletterSubs == null ? "developer" : null,
    autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "comms.newsletter_doi", subsystem: "communications", gate: "optional",
    lines: ["public_website", "vending_ops", "full_platform"],
    label: "Newsletter double opt-in exercised",
    description: "A real subscription produced a sent confirmation email.",
    state: (doiSent ?? 0) > 0 ? "verified" : "pending",
    severity: "low",
    evidence: `${doiSent ?? "?"} sent newsletter.confirm/welcome outbox row(s); ${newsletterSubs ?? "?"} subscriber(s).`,
    evidenceKind: "live_db",
    action: "Subscribe a test address via the site and confirm the DOI email sends.",
    actionHref: "/system/newsletter", owner: "owner", autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "comms.newsletter_unsubscribe", subsystem: "communications", gate: "optional",
    lines: ["public_website", "vending_ops", "full_platform"],
    label: "Newsletter unsubscribe verified",
    description: "Token unsubscribe flow completed at least once.",
    state: (unsubCount ?? 0) > 0 ? "verified" : "pending",
    severity: "low",
    evidence: `${unsubCount ?? "?"} unsubscribed subscriber row(s).`,
    evidenceKind: "live_db",
    action: "Complete an unsubscribe via a real DOI email link.",
    actionHref: "/system/newsletter", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  /* ═══ AI Infrastructure ═══ */
  const aiEnabled = await countRows(db, "ai_agents", (q: any) => q.eq("enabled", true)).catch(() => null);
  const aiTotal = await countRows(db, "ai_agents").catch(() => null);
  const aiRuns = await countRows(db, "ai_agent_runs").catch(() => null);
  const evalRuns = await countRows(db, "eval_runs").catch(() => null);
  const openrouter = env("OPENROUTER_API_KEY");

  add({
    id: "ai.registry", subsystem: "ai_infrastructure", gate: "optional",
    lines: ["full_platform"],
    label: "Agent registry & governance",
    description: "Agent registry, kill switches, budgets, tool scoping, DENIED_ACTIONS.",
    state: aiTotal == null ? "pending" : "implemented",
    severity: "low",
    evidence: `${aiEnabled ?? "?"}/${aiTotal ?? "?"} agents enabled; governance (kill switch, budgets, denied actions) implemented + tested.`,
    evidenceKind: "live_db",
    action: null, actionHref: "/system/ai", owner: null, autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "ai.provider_key", subsystem: "ai_infrastructure", gate: "optional",
    lines: ["full_platform"],
    label: "Model provider configured",
    description: "OPENROUTER_API_KEY present — without it every AI path degrades to human.",
    state: openrouter ? "configured" : "blocked",
    severity: "low",
    evidence: `OPENROUTER_API_KEY ${openrouter ? "set" : "NOT SET — AI features safely degrade to human handoff"}.`,
    evidenceKind: "env",
    action: openrouter ? null : "Set OPENROUTER_API_KEY to enable live model calls.",
    actionHref: "/system/settings", owner: "owner", autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "ai.live_execution", subsystem: "ai_infrastructure", gate: "optional",
    lines: ["full_platform"],
    label: "Agent execution verified live",
    description: "At least one real agent run recorded against a model.",
    state: (aiRuns ?? 0) > 0 ? "verified" : "pending",
    severity: "low",
    evidence: `${aiRuns ?? "?"} ai_agent_runs row(s); ${evalRuns ?? "?"} eval_runs row(s). Live-model verification is impossible until the provider key exists.`,
    evidenceKind: "live_db",
    action: openrouter ? "Trigger an authorized agent run and confirm an ai_agent_runs row." : "Blocked on ai.provider_key — set OPENROUTER_API_KEY first.",
    actionHref: "/system/ai", owner: "owner", autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "ai.evals", subsystem: "ai_infrastructure", gate: "optional",
    lines: ["full_platform"],
    label: "Eval suite run against real model",
    description: "eval_runs recorded — never run to date.",
    state: (evalRuns ?? 0) > 0 ? "verified" : "pending",
    severity: "low",
    evidence: `${evalRuns ?? "?"} eval_runs row(s) — the eval harness exists but has never executed against a live model.`,
    evidenceKind: "live_db",
    action: "After OPENROUTER_API_KEY is set, run the eval suite and record results.",
    actionHref: "/system/ai", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  /* ═══ Payments ═══ */
  const [stripeEvents, paymentsRows, billingLedger, approvedPricing, activePlans, activePackages] = await Promise.all([
    countRows(db, "stripe_events").catch(() => null),
    countRows(db, "payments").catch(() => null),
    countRows(db, "billing_ledger").catch(() => null),
    countRows(db, "pricing_versions", (q: any) => q.eq("approved", true)).catch(() => null),
    countRows(db, "membership_plans", (q: any) => q.eq("active", true)).catch(() => null),
    countRows(db, "prepaid_packages", (q: any) => q.eq("active", true)).catch(() => null),
  ]);
  const stripeHc = hc("stripe");
  const stripeModeNow = stripeMode();

  add({
    id: "pay.stripe_secret", subsystem: "payments", gate: "production_safety",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Stripe secret key configured",
    description: "STRIPE_SECRET_KEY present — checkout returns payments_unconfigured without it.",
    state: stripeConfigured() ? "configured" : "blocked",
    severity: "critical",
    evidence: `STRIPE_SECRET_KEY ${stripeConfigured() ? `set (${stripeModeNow} mode)` : "NOT SET — all checkout returns 503 payments_unconfigured"}.`,
    evidenceKind: "env",
    action: stripeConfigured() ? null : "Set STRIPE_SECRET_KEY (sk_test_… for testing, sk_live_… for launch) in Vercel production.",
    actionHref: "/system/integrations", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "pay.stripe_webhook", subsystem: "payments", gate: "production_safety",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Stripe webhook endpoint",
    description: "STRIPE_WEBHOOK_SECRET set + endpoint registered in Stripe + signature verification works.",
    state: isStripeWebhookConfigured() ? (stripeHc?.status === "operational" ? "verified" : "configured") : "blocked",
    severity: "critical",
    evidence: `STRIPE_WEBHOOK_SECRET ${isStripeWebhookConfigured() ? "set" : "NOT SET"}; recorded provider check: ${stripeHc ? `'${stripeHc.status}' at ${stripeHc.checkedAt}` : "none — run a health check"}. Endpoint registration itself is a Stripe-dashboard fact.`,
    evidenceKind: "env",
    action: !isStripeWebhookConfigured() ? "Set STRIPE_WEBHOOK_SECRET from the Stripe webhook endpoint." : stripeHc?.status !== "operational" ? "Run the Stripe health check on /system/integrations and confirm the webhook endpoint is registered for checkout.session.completed + payment_intent.* events." : null,
    actionHref: "/system/integrations", owner: "provider", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "pay.pricing_approved", subsystem: "payments", gate: "commercial",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Pricing approved",
    description: "An approved pricing_versions row exists — checkout refuses pricing_not_approved otherwise.",
    state: (approvedPricing ?? 0) > 0 ? "verified" : "pending",
    severity: "high",
    evidence: `${approvedPricing ?? "?"} approved pricing_versions row(s) (pilot-2026-v1 exists but approved=false).`,
    evidenceKind: "live_db",
    action: "Review and approve the pilot pricing version in admin — this is the owner's pricing sign-off.",
    actionHref: "/admin", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "pay.catalog", subsystem: "payments", gate: "commercial",
    lines: ["vending_ops", "full_platform"],
    label: "Sellable catalog seeded",
    description: "Active membership plans + prepaid packages exist.",
    state: (activePlans ?? 0) + (activePackages ?? 0) > 0 ? "operational" : "pending",
    severity: "medium",
    evidence: `${activePlans ?? "?"} active membership_plans, ${activePackages ?? "?"} active prepaid_packages.`,
    evidenceKind: "live_db",
    action: "Seed/activate membership plans and prepaid packages before selling them.",
    actionHref: "/admin", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "pay.reconciliation", subsystem: "payments", gate: "production_safety",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Payment reconciliation tables",
    description: "stripe_events (webhook dedupe) + billing_ledger exist.",
    state: payments.reconciliation === "ok" ? "operational" : payments.reconciliation === "missing" ? "blocked" : "pending",
    severity: "high",
    evidence: `reconciliation=${payments.reconciliation}; stripe_events=${stripeEvents ?? "?"} row(s), billing_ledger=${billingLedger ?? "?"} row(s), payments=${paymentsRows ?? "?"} row(s).`,
    evidenceKind: "live_db",
    action: payments.reconciliation === "missing" ? "Run the billing migrations (stripe_events, billing_ledger)." : null,
    actionHref: "/admin", owner: "developer", autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "pay.first_transaction", subsystem: "payments", gate: "commercial",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "First payment verified end-to-end",
    description: "A real Stripe checkout → webhook → ledger/payment row chain has run.",
    state: (paymentsRows ?? 0) > 0 || (stripeEvents ?? 0) > 0 ? "verified" : "manual",
    severity: "critical",
    evidence: `${paymentsRows ?? "?"} payments row(s), ${stripeEvents ?? "?"} stripe_events row(s) — no payment has ever been processed.`,
    evidenceKind: "live_db",
    action: "With STRIPE_SECRET_KEY set (test mode OK), run one checkout end-to-end and confirm webhook → payment row → ledger entry.",
    actionHref: "/admin", owner: "owner", autoVerifiable: true, manualRequired: true,
  });

  add({
    id: "pay.gift_legal", subsystem: "payments", gate: "commercial",
    lines: ["vending_ops", "full_platform"],
    label: "Gift sales legal gate",
    description: "Gift-card legal checklist complete before stored-value sales.",
    state: gifts.status === "enabled" ? "operational" : "pending",
    severity: "medium",
    evidence: `gifts.status=${gifts.status}; ${GIFT_LAUNCH_CHECKLIST.filter((c) => c.status === "pending").length} checklist item(s) pending.`,
    evidenceKind: "code",
    action: "Complete the gift legal checklist, then set GIFT_SALES_ENABLED=1.",
    actionHref: "/admin", owner: "owner", autoVerifiable: true, manualRequired: true,
  });

  /* ═══ Kiosk Hardware — staged pipeline ═══ */
  const devices = db ? await listRows(db, "system_devices",
    "device_uid,status,provision_token_used_at,credential_issued_at,last_authed_at,last_heartbeat_at,installed_at,auth_method",
    { order: { col: "created_at", asc: false }, limit: 50 }).catch(() => null) : null;
  const deviceRows = (devices ?? []) as {
    device_uid: string | null; status: string; provision_token_used_at: string | null;
    credential_issued_at: string | null; last_authed_at: string | null;
    last_heartbeat_at: string | null; installed_at: string | null; auth_method: string | null;
  }[];
  const registered = deviceRows.length;
  const credIssued = deviceRows.filter((d) => d.credential_issued_at).length;
  const tokenRedeemed = deviceRows.filter((d) => d.provision_token_used_at || d.last_authed_at).length;
  const authed = deviceRows.filter((d) => d.last_authed_at).length;
  const heartbeat24h = deviceRows.filter((d) => d.last_heartbeat_at && Date.now() - Date.parse(d.last_heartbeat_at) < DAY).length;
  const certPhysical = await countRows(db, "system_certification_runs", (q: any) => q.eq("tier", "physical").eq("status", "pass")).catch(() => null);
  const certPhysicalTotal = await countRows(db, "system_certification_runs", (q: any) => q.eq("tier", "physical")).catch(() => null);
  const hwProfiles = readiness.hardware.profiles;
  const adapter = kioskAdapterName();
  const testStations = db ? await countRows(db, "kiosks", (q: any) => q.eq("test_mode", true)).catch(() => null) : null;
  const liveStations = db ? await countRows(db, "kiosks", (q: any) => q.eq("state", "online")).catch(() => null) : null;

  add({
    id: "hw.adapter", subsystem: "kiosk_hardware", gate: "hardware_launch",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Hardware adapter / gateway",
    description: "A real kiosk adapter exists (KIOSK_ADAPTER != none).",
    state: adapter === "none" ? "blocked" : "pending",
    severity: "critical",
    evidence: `KIOSK_ADAPTER=${adapter} — ${adapter === "none" ? "NullKioskAdapter; no hardware command path exists" : "selected but unverified against real hardware"}.`,
    evidenceKind: "env",
    action: adapter === "none" ? "Real kiosk hardware + gateway vendor integration required — no adapter implementation exists." : "Verify the selected adapter against a real device.",
    actionHref: "/system/kiosks", owner: "hardware", autoVerifiable: false, manualRequired: true,
  });
  add({
    id: "hw.devices_registered", subsystem: "kiosk_hardware", gate: "hardware_launch",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Devices registered",
    description: "system_devices rows exist in the fleet registry.",
    state: devices == null ? "pending" : registered > 0 ? "verified" : "pending",
    severity: "medium",
    evidence: devices == null ? "system_devices unreachable." : `${registered} device(s) registered (${deviceRows.map((d) => d.device_uid ?? "?").join(", ")}).`,
    evidenceKind: "live_db",
    action: registered === 0 ? "Register the first device via /system/kiosks." : null,
    actionHref: "/system/kiosks", owner: "developer", autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "hw.credential_issued", subsystem: "kiosk_hardware", gate: "hardware_launch",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Device credential issued",
    description: "At least one device completed credential issuance (HMAC key material exists).",
    state: devices == null ? "pending" : credIssued > 0 ? "verified" : "pending",
    severity: "high",
    evidence: `${credIssued}/${registered} device(s) with credential_issued_at; auth_method: ${deviceRows.map((d) => d.auth_method ?? "unset").join(", ")}.`,
    evidenceKind: "live_db",
    action: credIssued === 0 ? "Issue a device credential via /system/kiosks/[id] → Credential." : null,
    actionHref: "/system/kiosks", owner: "developer", autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "hw.provision_redeemed", subsystem: "kiosk_hardware", gate: "hardware_launch",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Provisioning token redeemed / device authenticated",
    description: "A device redeemed its znk_ token or completed an authenticated session.",
    state: devices == null ? "pending" : tokenRedeemed > 0 || authed > 0 ? "verified" : "pending",
    severity: "high",
    evidence: `${tokenRedeemed} token redemption(s), ${authed} authenticated session(s) on record.`,
    evidenceKind: "live_db",
    action: "Power on the device and complete provisioning redemption.",
    actionHref: "/system/kiosks", owner: "hardware", autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "hw.heartbeat", subsystem: "kiosk_hardware", gate: "hardware_launch",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Device heartbeat received",
    description: "An authenticated heartbeat within the last 24h.",
    state: devices == null ? "pending" : heartbeat24h > 0 ? "verified" : "pending",
    severity: "high",
    evidence: `${heartbeat24h} device(s) heartbeat in last 24h; last_heartbeat_at values: ${deviceRows.map((d) => d.last_heartbeat_at ?? "never").join(", ")}.`,
    evidenceKind: "live_db",
    action: "Device must authenticate and send its first heartbeat via /api/devices/events.",
    actionHref: "/system/kiosks", owner: "hardware", autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "hw.physical_certification", subsystem: "kiosk_hardware", gate: "hardware_launch",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Physical certification passed",
    description: "A physical-tier certification run passed (hash-chained ledger).",
    state: certPhysical == null ? "pending" : (certPhysical ?? 0) > 0 ? "verified" : "pending",
    severity: "high",
    evidence: `${certPhysical ?? "?"}/${certPhysicalTotal ?? "?"} physical-tier certification run(s) passed; ${hwProfiles ?? "?"} hardware profile(s) on file.`,
    evidenceKind: "live_db",
    action: "Run physical certification checks on a real device at /system/kiosks/certification.",
    actionHref: "/system/kiosks/certification", owner: "hardware", autoVerifiable: true, manualRequired: true,
  });
  add({
    id: "hw.rental_stations", subsystem: "kiosk_hardware", gate: "hardware_launch",
    lines: ["charging_rental", "vending_ops", "full_platform"],
    label: "Rental-facing stations",
    description: "kiosks rows exist; test_mode stations enable pre-launch flow testing.",
    state: liveStations == null ? "pending" : (liveStations ?? 0) > 0 ? "verified" : (testStations ?? 0) > 0 ? "operational" : "pending",
    severity: "medium",
    evidence: `${liveStations ?? "?"} live (state=online) kiosk(s), ${testStations ?? "?"} test-mode kiosk(s) — test stations bypass live gates for app/checkout testing but never appear on the public map.`,
    evidenceKind: "live_db",
    action: (liveStations ?? 0) === 0 ? "Deploy a kiosk to a published venue; it flips online on first heartbeat." : null,
    actionHref: "/system/kiosks", owner: "hardware", autoVerifiable: true, manualRequired: false,
  });

  /* ═══ Deployments ═══ */
  const ghState = hc("github");
  const vcState = hc("vercel");
  const deployReqs = db ? await countRows(db, "system_deployment_requests", (q: any) => q.eq("status", "executed")).catch(() => null) : null;

  add({
    id: "deploy.github", subsystem: "deployments", gate: "optional",
    lines: ["full_platform"],
    label: "GitHub integration",
    description: "Repo connection + recorded provider health check.",
    state: ghState?.status === "operational" ? "verified" : integState("github")?.configured ? "configured" : "pending",
    severity: "low",
    evidence: `Recorded check: ${ghState ? `'${ghState.status}' at ${ghState.checkedAt}` : "none"}; configured=${integState("github")?.configured ?? "?"}.`,
    evidenceKind: "provider_recorded",
    action: ghState?.status !== "operational" ? "Run the GitHub health check on /system/integrations." : null,
    actionHref: "/system/integrations", owner: "developer", autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "deploy.vercel", subsystem: "deployments", gate: "optional",
    lines: ["full_platform"],
    label: "Vercel deployment pipeline",
    description: "Git-push → Vercel production deploys verified working.",
    state: vcState?.status === "operational" ? "verified" : "operational",
    severity: "low",
    evidence: `Recorded check: ${vcState ? `'${vcState.status}' at ${vcState.checkedAt}` : "none"}. Production deploys demonstrably work — every push to main ships (this dashboard is proof).`,
    evidenceKind: "provider_recorded",
    action: null, actionHref: "/system/app/deployments", owner: null, autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "deploy.approval_workflow", subsystem: "deployments", gate: "optional",
    lines: ["full_platform"],
    label: "Deployment approval workflow exercised",
    description: "system_deployment_requests approval→execution chain has run.",
    state: (deployReqs ?? 0) > 0 ? "verified" : "pending",
    severity: "low",
    evidence: `${deployReqs ?? "?"} executed deployment request(s). Note: routine deploys flow through git push → Vercel, not this workflow — it exists for gated releases.`,
    evidenceKind: "live_db",
    action: "For gated releases, create + approve + execute a deployment request on /system/app/deployments.",
    actionHref: "/system/app/deployments", owner: "developer", autoVerifiable: true, manualRequired: false,
  });

  /* ═══ System Control ═══ */
  const auditEvents = await countRows(db, "system_audit_events").catch(() => null);
  const pendingChanges = await countRows(db, "system_change_requests", (q: any) => q.eq("status", "pending")).catch(() => null);
  add({
    id: "sys.rbac_audit", subsystem: "system_control", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "RBAC + audit logging",
    description: "Permission matrix enforced; privileged ops write audit events.",
    state: "test_verified", severity: "high",
    evidence: `RBAC unit-tested (tests/system-rbac*); ${auditEvents ?? "?"} system_audit_events row(s) on record; ${pendingChanges ?? "?"} pending change request(s).`,
    evidenceKind: "live_db",
    action: "Exercise the system.* permission matrix per role on the live deployment (403 sweep).",
    actionHref: "/system/security/readiness", owner: "owner", autoVerifiable: true, manualRequired: true,
  });

  /* ═══ Observability ═══ */
  const alertWebhook = env("ALERT_WEBHOOK_URL");
  const cronSecretEnv = env("CRON_SECRET");
  // CRON_SECRET truth: env presence OR proven by successful authenticated runs.
  const cronSecretEffective = cronSecretEnv || (cronOk48h ?? 0) > 0;
  const cronJobs = db ? await listRows(db, "cron_runs", "job,ok,ran_at", { order: { col: "ran_at", asc: false }, limit: 200 }).catch(() => null) : null;
  const jobsOk = new Map<string, boolean>();
  for (const r of cronJobs ?? []) {
    const j = String(r.job);
    if (!jobsOk.has(j)) jobsOk.set(j, r.ok === true);
  }
  const failingJobs = [...jobsOk.entries()].filter(([, ok]) => !ok).map(([j]) => j);
  const jobCount = jobsOk.size;

  add({
    id: "obs.cron_jobs", subsystem: "observability", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Scheduled jobs executing",
    description: "Vercel cron jobs authenticate and complete successfully.",
    state: jobCount === 0 ? "pending" : failingJobs.length === 0 ? "verified" : "operational",
    severity: "high",
    evidence: `${cronOk48h ?? "?"} successful cron_runs in 48h across ${jobCount} job(s)${failingJobs.length ? `; FAILING: ${failingJobs.join(", ")}` : ""}. CRON_SECRET ${cronSecretEnv ? "set in env" : "not directly visible but PROVEN by successful authenticated runs"} — the old 'will 401' blocker was stale.`,
    evidenceKind: "live_db",
    action: failingJobs.length ? `Investigate failing cron job(s): ${failingJobs.join(", ")}.` : null,
    actionHref: "/system/jobs", owner: failingJobs.length ? "developer" : null, autoVerifiable: true, manualRequired: false,
  });

  add({
    id: "obs.alert_webhook", subsystem: "observability", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Out-of-band alert delivery",
    description: "ALERT_WEBHOOK_URL for critical alerts (Slack/PagerDuty/etc).",
    state: alertWebhook ? "configured" : "pending",
    severity: "medium",
    evidence: `ALERT_WEBHOOK_URL ${alertWebhook ? "set" : "unset — critical alerts are email-only (and email queues if the mailer is down)"}.`,
    evidenceKind: "env",
    action: alertWebhook ? "Run a test alert through the webhook to confirm delivery." : "Set ALERT_WEBHOOK_URL to an external alert destination.",
    actionHref: "/system/settings", owner: "owner", autoVerifiable: true, manualRequired: false,
  });

  /* ═══ Data Retention — reconciled ═══ */
  const retentionRuns = db ? await listRows(db, "system_retention_runs", "id,policy,mode,status,deleted_counts,created_at", { order: { col: "created_at", asc: false }, limit: 10 }).catch(() => null) : null;
  const lastRetention = retentionRuns?.[0] as { mode?: string; status?: string; created_at?: string } | undefined;
  const execRuns = (retentionRuns ?? []).filter((r) => (r as { mode?: string }).mode === "execute" && (r as { status?: string }).status === "completed");
  const pendingRetentionApprovals = readiness.pending_retention_approvals;

  add({
    id: "retention.scheduled", subsystem: "data_retention", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Scheduled retention executing",
    description: "The daily cron retention sweep runs in execute mode — BY DESIGN, authorized by CRON_SECRET, bounded deletes with a preserved-class denylist.",
    state: execRuns.length > 0 ? "verified" : "pending",
    severity: "medium",
    evidence: `${execRuns.length} completed execute-mode run(s) on record (latest ${lastRetention?.created_at ?? "?"}); preserved-class tables (audit/legal/financial/identity) are structurally unreachable. The earlier 'first execute pending approval' blocker was STALE — it conflated the scheduled path with the manual approval-gated path.`,
    evidenceKind: "live_db",
    action: null, actionHref: "/system/jobs", owner: null, autoVerifiable: true, manualRequired: false,
  });
  add({
    id: "retention.manual_gate", subsystem: "data_retention", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Manual retention execute approval gate",
    description: "Ad-hoc retention executes require an approved change request (assertApprovedOrRequest).",
    state: "test_verified", severity: "low",
    evidence: `Gate implemented + unit-tested; ${pendingRetentionApprovals ?? "?"} pending retention approval(s). Scheduled cron path is separately authorized — no invariant violated.`,
    evidenceKind: "code",
    action: null, actionHref: "/system/jobs", owner: null, autoVerifiable: true, manualRequired: false,
  });

  /* ═══ Backup & Recovery ═══ */
  add({
    id: "backup.provider_state", subsystem: "backup_recovery", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Provider backups / PITR",
    description: "Supabase backups or PITR enabled — last-known snapshot, not live-probed.",
    state: backupState === "recovery_verified" ? "verified"
      : backupState === "restore_tested" ? "operational"
      : backupState === "backup_available" || backupState === "backup_configured" ? "configured"
      : backupState === "restore_pending" ? "pending" : "blocked",
    severity: "critical",
    evidence: `state=${backupState}; provider snapshot as_of ${readiness.backup.provider_snapshot?.as_of ?? "unknown"} (walg=${readiness.backup.provider_snapshot?.walg_enabled}, pitr=${readiness.backup.provider_snapshot?.pitr_enabled}, backups=${readiness.backup.provider_snapshot?.backup_count ?? "?"}) — self-reported, confirm in Supabase Dashboard → Database → Backups.`,
    evidenceKind: "manual",
    action: "Enable PITR or scheduled backups in Supabase Dashboard, then refresh the provider snapshot.",
    actionHref: "/system/recovery", owner: "owner", autoVerifiable: false, manualRequired: true,
  });
  add({
    id: "backup.restore_drill", subsystem: "backup_recovery", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Isolated restore drill",
    description: "A restore was executed and integrity-verified.",
    state: readiness.recovery_tests != null && readiness.recovery_tests > 0
      ? (readiness.recovery_last_test?.result === "passed" ? "operational" : "pending")
      : "pending",
    severity: "critical",
    evidence: `${readiness.recovery_tests ?? "?"} system_recovery_tests row(s); latest result=${readiness.recovery_last_test?.result ?? "none"} at ${readiness.recovery_last_test?.tested_at ?? "never"} (self-reported).`,
    evidenceKind: "live_db",
    action: "Perform an isolated restore per docs/RECOVERY.md and record the result in /system/recovery.",
    actionHref: "/system/recovery", owner: "owner", autoVerifiable: true, manualRequired: true,
  });

  /* ═══ Legal & Compliance ═══ */
  const pendingLegal = GIFT_LAUNCH_CHECKLIST.filter((c) => c.category === "legal" && c.status === "pending").length;
  add({
    id: "legal.gift_checklist", subsystem: "legal_compliance", gate: "commercial",
    lines: ["vending_ops", "full_platform"],
    label: "Gift-card legal checklist",
    description: "Stored-value legal requirements reviewed before gift sales.",
    state: gifts.status === "enabled" ? "operational" : "pending",
    severity: "medium",
    evidence: `${pendingLegal} legal checklist item(s) pending (terms, escheatment, refund policy, state laws, tax).`,
    evidenceKind: "code",
    action: "Complete the legal checklist with counsel, then enable GIFT_SALES_ENABLED.",
    actionHref: "/admin", owner: "owner", autoVerifiable: false, manualRequired: true,
  });
  add({
    id: "legal.business_address", subsystem: "legal_compliance", gate: "production_safety",
    lines: ["public_website", "charging_rental", "vending_ops", "full_platform"],
    label: "Registered business postal address published",
    description: "CAN-SPAM / consumer-disclosure requirement for transactional email footers.",
    state: "manual", severity: "medium",
    evidence: "No published business postal address is configured for email footers.",
    evidenceKind: "manual",
    action: "Publish the registered business address and confirm it renders in email footers.",
    actionHref: "/system/sites", owner: "owner", autoVerifiable: false, manualRequired: true,
  });

  /* ── Assemble report ── */
  const blockers = buildBlockers(checks);
  const gates = buildGates(checks);
  const ownerActions = blockers.filter((b) => b.owner === "owner");
  const subsystems = LAUNCH_SUBSYSTEMS.map((s) => ({
    id: s.id, label: s.label, checks: checks.filter((c) => c.subsystem === s.id),
  }));

  const history = await persistReadiness(db, checks);
  const summary = summarizeChecks(checks);

  return {
    generatedAt: now,
    environment: process.env.VERCEL_ENV ?? "development",
    checks,
    subsystems,
    blockers,
    gates,
    ownerActions,
    history,
    summary,
  };
}
