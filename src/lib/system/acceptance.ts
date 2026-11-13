import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase";
import { listIntegrationStatus, type IntegrationRow } from "./integrations";
import { securityReadiness, type SecurityReadiness } from "./readiness";
import { kioskAdapterName } from "./kiosks";
import { mailerConfigured } from "@/lib/helpdesk/mailer";

/**
 * Operational acceptance checks — Phase-8-style evidence verification for the
 * launch dashboard. Unlike ops-status (subsystem readiness), each check here
 * answers "has this operational capability been PROVEN to work?".
 *
 * HONESTY RULES (same contract as launch.ts / ops-status.ts):
 *  - 'verified' is emitted ONLY with real evidence: DB rows proving the flow
 *    ran (revisions, sent outbox, delivery events, executed requests, passed
 *    restore tests, heartbeats, certification passes) or a recorded passing
 *    provider health check. Code existence and env-var presence NEVER verify.
 *  - Env/config presence alone → 'pending' with blocker 'credentials/config'.
 *  - A missing table or unreachable probe → 'pending'/'blocked' naming the
 *    exact next action (migration, credential, human step).
 *  - Steps that fundamentally require a human (visual preview check) are
 *    'pending' + manual:true — never faked, never auto-passed.
 *  - Every check links to the console page that manages it.
 *
 * All queries are bounded: count/head probes or small limited selects. No
 * live provider calls happen here — recorded evidence only.
 */

export type AcceptanceState = "verified" | "pending" | "blocked" | "failed";
export type AcceptanceCategoryId =
  | "website_ops"
  | "deployment_ops"
  | "communications"
  | "security"
  | "recovery"
  | "hardware";

export type AcceptanceCheck = {
  id: string;
  category: AcceptanceCategoryId;
  label: string;
  state: AcceptanceState;
  /** What was actually observed — counts, timestamps, recorded statuses. */
  evidence: string;
  lastChecked: string;
  /** System console page that manages this capability. */
  href: string;
  /** Exact next action when the check is not verified. */
  blocker?: string | null;
  /** True when only a human can complete the verification step. */
  manual?: boolean;
};

export type AcceptanceCategory = {
  id: AcceptanceCategoryId;
  label: string;
  checks: AcceptanceCheck[];
};

export type AcceptanceReport = {
  generatedAt: string;
  categories: AcceptanceCategory[];
  counts: Record<AcceptanceState, number>;
};

export const ACCEPTANCE_CATEGORIES: readonly { id: AcceptanceCategoryId; label: string }[] = [
  { id: "website_ops", label: "Website operations" },
  { id: "deployment_ops", label: "Deployment operations" },
  { id: "communications", label: "Communications" },
  { id: "security", label: "Security" },
  { id: "recovery", label: "Recovery" },
  { id: "hardware", label: "Hardware" },
];

const NEWSLETTER_EVENTS = ["newsletter.confirm", "newsletter.welcome"] as const;
const HEARTBEAT_WINDOW_MS = 24 * 3600_000;

/* ── Bounded probes ─────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

/** Head-count probe; null = table missing/unreachable (never a fake zero). */
async function countRows(
  db: SupabaseClient,
  table: string,
  apply?: (q: any) => any,
): Promise<number | null> {
  try {
    let q = db.from(table).select("*", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

/** Small limited select; null = table missing/unreachable. */
async function listRows(
  db: SupabaseClient,
  table: string,
  cols: string,
  opts: { order?: { col: string; asc?: boolean }; limit?: number } = {},
): Promise<Row[] | null> {
  try {
    let q = db.from(table).select(cols);
    if (opts.order) q = q.order(opts.order.col, { ascending: opts.order.asc ?? false });
    if (opts.limit) q = q.limit(opts.limit);
    const { data, error } = await q;
    return error ? null : ((data ?? []) as unknown as Row[]);
  } catch {
    return null;
  }
}

function mk(
  partial: Omit<AcceptanceCheck, "lastChecked"> & { lastChecked?: string },
  now: string,
): AcceptanceCheck {
  return { lastChecked: now, ...partial };
}

const iso = (v: unknown): string | null =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;

/* ── Provider evidence helpers ──────────────────────────────────────────── */

function providerState(
  row: IntegrationRow | undefined,
  providerLabel: string,
): { state: AcceptanceState; evidence: string; blocker: string | null; lastChecked?: string } {
  if (!row) {
    return { state: "pending", evidence: `${providerLabel} missing from integration registry.`, blocker: "credentials/config — provider not registered" };
  }
  const hc = row.lastHealthCheck;
  if (hc?.status === "operational") {
    return {
      state: "verified",
      evidence: `Recorded health check 'operational' at ${hc.checkedAt}${hc.detail ? ` — ${hc.detail}` : ""}.`,
      blocker: null,
      lastChecked: hc.checkedAt,
    };
  }
  if (hc?.status === "degraded") {
    return {
      state: "failed",
      evidence: `Recorded health check 'degraded' at ${hc.checkedAt}${hc.detail ? ` — ${hc.detail}` : ""}.`,
      blocker: "Provider check failing — investigate on /system/integrations",
      lastChecked: hc.checkedAt,
    };
  }
  if (!row.configured) {
    return {
      state: "pending",
      evidence: `${providerLabel} env vars not all set (${row.envVars.join(", ") || "see registry"}).`,
      blocker: "credentials/config — set required env vars, then run a health check",
    };
  }
  return {
    state: "pending",
    evidence: `${providerLabel} configured${hc ? `; last recorded check '${hc.status}' at ${hc.checkedAt}` : " but never health-checked"}.`,
    blocker: "Run an on-demand health check on /system/integrations — env presence alone is not verification",
    lastChecked: hc?.checkedAt,
  };
}

/* ── Main entry ─────────────────────────────────────────────────────────── */

export async function getAcceptanceChecks(
  dbOverride?: SupabaseClient | null,
): Promise<AcceptanceReport> {
  const db = dbOverride === undefined ? serviceClient() : dbOverride;
  const now = new Date().toISOString();
  const checks: AcceptanceCheck[] = [];

  /* Shared evidence gathers (bounded; each independently fault-tolerant). */
  const [integrations, readiness, revisionTotal, publishedCount, revertCount] = await Promise.all([
    listIntegrationStatus(db),
    securityReadiness(db),
    db ? countRows(db, "site_content_revisions") : Promise.resolve(null),
    db ? countRows(db, "site_content", (q) => q.eq("status", "published")) : Promise.resolve(null),
    db ? countRows(db, "site_content_revisions", (q) => q.eq("action", "revert")) : Promise.resolve(null),
  ]);
  const byId = new Map(integrations.map((r) => [r.id, r]));

  /* ── Website operations ─────────────────────────────────────────────── */

  checks.push(mk({
    id: "cms_draft_saved", category: "website_ops",
    label: "CMS draft saved",
    state: !db ? "pending" : revisionTotal === null ? "blocked" : revisionTotal > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured — cannot inspect site_content_revisions."
      : revisionTotal === null
        ? "site_content_revisions table unreachable — check migration 0058."
        : `${revisionTotal} revision row(s) on record (save_draft/publish/schedule/revert history).`,
    href: "/system/sites",
    blocker: !db ? "Supabase backend not configured"
      : revisionTotal === null ? "Run migration 0058 (site CMS)"
      : revisionTotal === 0 ? "Save a draft field via /system/sites to produce the first revision" : null,
  }, now));

  checks.push(mk({
    id: "cms_published", category: "website_ops",
    label: "Publication verified",
    state: !db ? "pending" : publishedCount === null ? "blocked" : publishedCount > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : publishedCount === null
        ? "site_content table unreachable — check migration 0058."
        : `${publishedCount} site_content row(s) with status='published' — content is live-serving.`,
    href: "/system/sites",
    blocker: !db ? "Supabase backend not configured"
      : publishedCount === null ? "Run migration 0058 (site CMS)"
      : publishedCount === 0 ? "Publish a field via /system/sites — draft-only content never reaches the site" : null,
  }, now));

  checks.push(mk({
    id: "cms_revert_verified", category: "website_ops",
    label: "Revision restore verified",
    state: !db ? "pending" : revertCount === null ? "blocked" : revertCount > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : revertCount === null
        ? "site_content_revisions table unreachable."
        : revertCount > 0
          ? `${revertCount} 'revert' revision action(s) on record — restore path has run.`
          : "0 'revert' actions — the revert code path exists but has never been exercised.",
    href: "/system/sites",
    blocker: !db ? "Supabase backend not configured"
      : revertCount === null ? "Run migration 0058"
      : revertCount === 0 ? "Perform a revision restore on /system/sites and confirm the published value rolls back" : null,
  }, now));

  checks.push(mk({
    id: "cms_preview", category: "website_ops",
    label: "Preview verified",
    state: "pending",
    manual: true,
    evidence:
      "No preview-token / draft-preview system exists in the codebase — published-vs-draft state is only observable on the live site. A visual check on a preview deploy or local build is required.",
    href: "/system/sites",
    blocker: "Manual step: publish to a preview environment (or run locally) and visually confirm draft changes appear only after publish",
  }, now));

  /* ── Deployment operations ───────────────────────────────────────────── */

  const deployRows = db
    ? await listRows(db, "system_deployment_requests",
        "id,action,target_env,status,requested_by,decided_by,created_at,result",
        { order: { col: "created_at", asc: false }, limit: 100 })
    : null;

  const gh = providerState(byId.get("github"), "GitHub");
  checks.push(mk({
    id: "github_connected", category: "deployment_ops",
    label: "GitHub connected",
    state: gh.state, evidence: gh.evidence, href: "/system/integrations",
    blocker: gh.blocker, lastChecked: gh.lastChecked,
  }, now));

  const vc = providerState(byId.get("vercel"), "Vercel");
  checks.push(mk({
    id: "vercel_connected", category: "deployment_ops",
    label: "Vercel connected",
    state: vc.state, evidence: vc.evidence, href: "/system/integrations",
    blocker: vc.blocker, lastChecked: vc.lastChecked,
  }, now));

  // Executed non-production requests = preview deployment evidence.
  const previewExec = deployRows?.filter(
    (r) => r.status === "executed" && r.target_env !== "production",
  ) ?? null;
  checks.push(mk({
    id: "preview_deployment_verified", category: "deployment_ops",
    label: "Preview deployment verified",
    state: !db ? "pending" : deployRows === null ? "blocked" : (previewExec?.length ?? 0) > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : deployRows === null
        ? "system_deployment_requests table unreachable — check migration 0045."
        : (previewExec?.length ?? 0) > 0
          ? `${previewExec!.length} executed preview/development deployment request(s); latest ${iso(previewExec![0].created_at) ?? "unknown"}.`
          : "No executed preview deployment request on record.",
    href: "/system/app/deployments",
    blocker: !db ? "Supabase backend not configured"
      : deployRows === null ? "Run migration 0045"
      : "Create + execute a preview deployment request on /system/app/deployments",
  }, now));

  const prodExec = deployRows?.filter(
    (r) => r.status === "executed" && r.target_env === "production",
  ) ?? null;
  const prodApprovedPending = deployRows?.filter(
    (r) => r.status === "approved" && r.target_env === "production",
  ) ?? null;
  checks.push(mk({
    id: "production_release_authorized", category: "deployment_ops",
    label: "Production release authorization verified",
    state: !db ? "pending" : deployRows === null ? "blocked" : (prodExec?.length ?? 0) > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : deployRows === null
        ? "system_deployment_requests table unreachable."
        : (prodExec?.length ?? 0) > 0
          ? `${prodExec!.length} executed production deployment request(s) — approval → execution chain on record.`
          : (prodApprovedPending?.length ?? 0) > 0
            ? `${prodApprovedPending!.length} production request(s) approved but not yet executed.`
            : "No approved+executed production deployment request exists.",
    href: "/system/app/deployments",
    blocker: !db ? "Supabase backend not configured"
      : deployRows === null ? "Run migration 0045"
      : "Authorize + execute a production deployment via /system/app/deployments (requires approval + step-up)",
  }, now));

  // Release health: request-level health probes and app health profiles.
  const healthRows = db
    ? await listRows(db, "system_audit_events",
        "id,action,detail,created_at",
        { order: { col: "created_at", asc: false }, limit: 200 })
    : null;
  const healthyEvents = (healthRows ?? []).filter((r) => {
    const d = r.detail as Record<string, unknown> | null;
    return (
      (r.action === "deployment.health_checked" || r.action === "deployment.health_profile") &&
      d?.health_status === "healthy"
    );
  });
  const requestHealthy = (prodExec ?? []).some((r) => {
    const res = r.result as Record<string, unknown> | null;
    const health = res?.health as Record<string, unknown> | null;
    const profile = res?.healthProfile as Record<string, unknown> | null;
    return health?.status === "healthy" || profile?.status === "healthy";
  });
  const healthEvidenceCount = healthyEvents.length + (requestHealthy ? 1 : 0);
  checks.push(mk({
    id: "release_health_verified", category: "deployment_ops",
    label: "Release health verified",
    state: !db ? "pending" : healthRows === null && deployRows === null ? "blocked"
      : healthEvidenceCount > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : healthEvidenceCount > 0
        ? `${healthyEvents.length} healthy deployment.health_* audit event(s)${requestHealthy ? " + healthy health stored on an executed production request" : ""}; latest ${iso(healthyEvents[0]?.created_at) ?? "on request record"}.`
        : "No healthy post-deploy probe or health-profile result on record.",
    href: "/system/app/deployments",
    blocker: !db ? "Supabase backend not configured"
      : "Execute a production deployment, then run the post-deploy health check / monitor pass",
  }, now));

  /* ── Communications ─────────────────────────────────────────────────── */

  const [sentAny, sentDoi, deliveryEvents, unsubscribed] = await Promise.all([
    db ? countRows(db, "email_outbox", (q) => q.eq("status", "sent")) : Promise.resolve(null),
    db ? countRows(db, "email_outbox", (q) => q.eq("status", "sent").in("event", [...NEWSLETTER_EVENTS])) : Promise.resolve(null),
    db ? countRows(db, "email_delivery_events") : Promise.resolve(null),
    db ? countRows(db, "newsletter_subscribers", (q) => q.eq("status", "unsubscribed")) : Promise.resolve(null),
  ]);

  const mailer = mailerConfigured();
  // 'verified' requires a real send on record — a recorded provider health
  // check proves credentials work, not that mail actually flows.
  checks.push(mk({
    id: "email_sender_verified", category: "communications",
    label: "Sender verified",
    state: !db ? "pending" : sentAny !== null && sentAny > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : sentAny !== null && sentAny > 0
        ? `${sentAny} email_outbox row(s) with status='sent' — the mailer reached a provider.`
        : mailer
          ? `Mailer env configured (BREVO_API_KEY/RESEND_API_KEY + sender) but ${sentAny ?? "?"} sent outbox row(s) — no real send on record.`
          : "No mailer provider key configured (BREVO_API_KEY / RESEND_API_KEY / SUPPORT_FROM_EMAIL).",
    href: "/system/newsletter",
    blocker: !db ? "Supabase backend not configured"
      : !mailer ? "credentials/config — set BREVO_API_KEY or RESEND_API_KEY + SUPPORT_FROM_EMAIL"
      : "Send a test email (e.g. a DOI confirmation) and confirm an outbox row reaches 'sent'",
  }, now));

  checks.push(mk({
    id: "doi_confirmation_accepted", category: "communications",
    label: "Confirmation accepted (DOI)",
    state: !db ? "pending" : sentDoi === null ? "blocked" : sentDoi > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : sentDoi === null
        ? "email_outbox table unreachable."
        : sentDoi > 0
          ? `${sentDoi} sent newsletter.confirm/newsletter.welcome outbox row(s) — double opt-in mail reached the provider.`
          : "No sent DOI confirmation/welcome email on record.",
    href: "/system/newsletter",
    blocker: !db ? "Supabase backend not configured"
      : sentDoi === null ? "Check email_outbox migration"
      : "Subscribe a test address via the site popup and confirm the DOI email sends",
  }, now));

  checks.push(mk({
    id: "delivery_webhook_verified", category: "communications",
    label: "Delivery webhook verified",
    state: !db ? "pending" : deliveryEvents === null ? "blocked" : deliveryEvents > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : deliveryEvents === null
        ? "email_delivery_events table unreachable — check migration 0064 and provider webhook config."
        : deliveryEvents > 0
          ? `${deliveryEvents} provider delivery event row(s) received — webhook signature/secret path has run.`
          : "No provider delivery events recorded — webhook configured? (Brevo shared secret / Resend svix)",
    href: "/system/newsletter",
    blocker: !db ? "Supabase backend not configured"
      : deliveryEvents === null ? "Run migration 0064 (email_delivery_events)"
      : "Configure the provider delivery webhook (Resend svix / Brevo) and confirm an event lands",
  }, now));

  checks.push(mk({
    id: "unsubscribe_verified", category: "communications",
    label: "Unsubscribe verified",
    state: !db ? "pending" : unsubscribed === null ? "blocked" : unsubscribed > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : unsubscribed === null
        ? "newsletter_subscribers table unreachable — check migration 0060."
        : unsubscribed > 0
          ? `${unsubscribed} subscriber row(s) with status='unsubscribed' — token unsubscribe flow has completed.`
          : "No unsubscribed subscriber on record — the token flow exists but is unexercised.",
    href: "/system/newsletter",
    blocker: !db ? "Supabase backend not configured"
      : unsubscribed === null ? "Run migration 0060"
      : "Complete an unsubscribe via a real DOI email link to verify the token flow end-to-end",
  }, now));

  /* ── Security (reuse the readiness probes + admin checklist) ─────────── */

  const checklistItem = (id: string) => readiness.admin_checklist.find((i) => i.id === id);
  const secState = (
    itemId: string,
  ): { state: AcceptanceState; evidence: string; blocker: string | null; manual?: boolean } => {
    const item = checklistItem(itemId);
    if (!item) return { state: "pending", evidence: "Checklist item unavailable.", blocker: "security readiness probe incomplete" };
    if (item.status === "verified_by_code") {
      return { state: "verified", evidence: item.evidence, blocker: null };
    }
    if (item.status === "blocked") {
      return { state: "blocked", evidence: item.evidence, blocker: item.action };
    }
    return { state: "pending", evidence: item.evidence, blocker: item.action, manual: true };
  };

  const firstAdmin = secState("first_admin_role");
  checks.push(mk({
    id: "first_admin_enrolled", category: "security",
    label: "First admin enrolled",
    state: firstAdmin.state, evidence: firstAdmin.evidence, href: "/system/security/readiness",
    blocker: firstAdmin.blocker, manual: firstAdmin.manual,
  }, now));

  const mfa = secState("mfa_verify_tested");
  checks.push(mk({
    id: "mfa_verified", category: "security",
    label: "MFA verified",
    state: mfa.state, evidence: mfa.evidence, href: "/system/security/mfa",
    blocker: mfa.blocker, manual: mfa.manual,
  }, now));

  const stepUp = secState("step_up_elevation");
  checks.push(mk({
    id: "step_up_verified", category: "security",
    label: "Step-up verified",
    state: stepUp.state, evidence: stepUp.evidence, href: "/system/security/readiness",
    blocker: stepUp.blocker, manual: stepUp.manual,
  }, now));

  // Session expiration is code-enforced (24h absolute ceiling) but has never
  // been observed live — honesty rules forbid 'verified' from code alone.
  const sessItem = checklistItem("session_expiration");
  checks.push(mk({
    id: "session_expiration", category: "security",
    label: "Session expiration enforced",
    state: "pending",
    manual: true,
    evidence: sessItem?.evidence
      ?? "SESSION_MAX_AGE_MS = 24h enforced in src/lib/auth.ts — code-verified only, never observed live.",
    href: "/system/security/sessions",
    blocker: "Optional live spot-check: let a session cross 24h and confirm requests return 401",
  }, now));

  // Access restrictions: real evidence = system_role grants exist; the RBAC
  // matrix itself is code + unit tests (noted honestly in evidence).
  const roleProfiles = db
    ? await countRows(db, "profiles", (q) => q.not("system_role", "is", null)).catch(() => null)
    : null;
  const grants = readiness.bootstrap_grants;
  const hasGrants = (typeof roleProfiles === "number" && roleProfiles > 0) || (typeof grants === "number" && grants > 0);
  checks.push(mk({
    id: "access_restrictions", category: "security",
    label: "Access restrictions verified",
    state: !db ? "pending" : roleProfiles === null && grants === null ? "pending" : hasGrants ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : hasGrants
        ? `${roleProfiles ?? "?"} profile(s) hold a system_role; ${grants ?? "?"} bootstrap grant(s). RBAC permission matrix is code-enforced + unit-tested (tests/system-rbac*); a live per-role 403 sweep is still outstanding.`
        : "No system_role grants or bootstrap grants on record — no restricted principal exists yet.",
    href: "/system/security/readiness",
    blocker: !db ? "Supabase backend not configured"
      : "Complete first-admin bootstrap, then exercise the system.* permission matrix per role on the live deployment",
  }, now));

  /* ── Recovery ────────────────────────────────────────────────────────── */

  const backupState = readiness.backup.state;
  const backupVerified = ["backup_available", "restore_tested", "recovery_verified"].includes(backupState);
  checks.push(mk({
    id: "backup_exists", category: "recovery",
    label: "Backup exists",
    state: !db ? "pending" : backupState === "no_verified_backup" ? "blocked"
      : backupState === "backup_configured" || backupState === "restore_pending" ? "pending"
      : backupVerified ? "verified" : "pending",
    evidence: readiness.generated_at
      ? `Backup state '${backupState}' (provider snapshot as_of ${readiness.backup.provider_snapshot?.as_of ?? "unknown"}, self-reported — not live-probed).`
      : `Backup state '${backupState}'.`,
    href: "/system/recovery",
    blocker: backupState === "no_verified_backup"
      ? "Enable PITR or scheduled backups in Supabase Dashboard, refresh the provider snapshot, then test a restore"
      : backupState === "backup_configured"
        ? "PITR/WAL configured but no listed backup confirmed — verify a restorable backup exists in Supabase Dashboard → Database → Backups"
        : backupState === "restore_pending"
          ? "Restore test recorded but none passed — see restore validation check"
          : null,
    lastChecked: readiness.generated_at,
  }, now));

  const recTests = readiness.recovery_tests;
  checks.push(mk({
    id: "restore_test_completed", category: "recovery",
    label: "Restore test completed",
    state: !db ? "pending" : recTests === null ? "pending" : recTests > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : recTests === null
        ? "system_recovery_tests unavailable."
        : recTests > 0
          ? `${recTests} recovery test record(s); latest: result=${readiness.recovery_last_test?.result ?? "?"} at ${readiness.recovery_last_test?.tested_at ?? "?"} (self-reported).`
          : "No system_recovery_tests rows — no restore drill has ever been recorded.",
    href: "/system/recovery",
    blocker: !db ? "Supabase backend not configured"
      : "Perform an isolated restore exercise per docs/RECOVERY.md and record it in /system/recovery",
  }, now));

  const lastResult = readiness.recovery_last_test?.result ?? null;
  checks.push(mk({
    id: "restore_validation_passed", category: "recovery",
    label: "Restore validation passed",
    state: !db ? "pending" : lastResult === "passed" ? "verified"
      : recTests !== null && recTests > 0 ? "failed" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : lastResult === "passed"
        ? `Latest recovery test passed (${readiness.recovery_last_test?.environment ?? "?"}, ${readiness.recovery_last_test?.tested_at ?? "?"}) — self-reported by operator.`
        : recTests !== null && recTests > 0
          ? `${recTests} recovery test(s) recorded, none with result='passed' (latest: ${lastResult ?? "unknown"}).`
          : "No recovery test records exist.",
    href: "/system/recovery",
    blocker: lastResult === "passed" ? null
      : recTests !== null && recTests > 0
        ? "Investigate the failed/partial restore test and re-run per docs/RECOVERY.md"
        : "Run a restore drill and record a passing result",
  }, now));

  /* ── Hardware ────────────────────────────────────────────────────────── */

  const adapter = kioskAdapterName();
  checks.push(mk({
    id: "gateway_configured", category: "hardware",
    label: "Gateway configured",
    state: adapter === "none" ? "blocked" : "pending",
    evidence: `KIOSK_ADAPTER=${adapter}${adapter === "none" ? " (NullKioskAdapter — no hardware path exists)" : " — adapter selected but unverified against real hardware"}.`,
    href: "/system/kiosks",
    blocker: adapter === "none"
      ? "Real kiosk hardware + gateway vendor documentation required — no adapter implementation exists"
      : "Adapter selected but no certified hardware profile or device evidence exists",
  }, now));

  const [deviceTotal, deviceHeartbeat] = db
    ? await Promise.all([
        countRows(db, "system_devices"),
        countRows(db, "system_devices", (q) =>
          q.not("last_heartbeat_at", "is", null).gte("last_heartbeat_at", new Date(Date.now() - HEARTBEAT_WINDOW_MS).toISOString())),
      ])
    : [null, null];

  checks.push(mk({
    id: "device_provisioned", category: "hardware",
    label: "Device provisioned",
    state: !db ? "pending" : deviceTotal === null ? "blocked" : deviceTotal > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : deviceTotal === null
        ? "system_devices table unreachable — check migration 0042/0046."
        : `${deviceTotal} system_devices row(s) registered.`,
    href: "/system/kiosks",
    blocker: !db ? "Supabase backend not configured"
      : deviceTotal === null ? "Run device-fleet migrations"
      : "Provision the first kiosk via /system/kiosks onboarding",
  }, now));

  checks.push(mk({
    id: "heartbeat_authenticated", category: "hardware",
    label: "Authenticated heartbeat",
    state: !db ? "pending" : deviceHeartbeat === null ? "blocked" : deviceHeartbeat > 0 ? "verified" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : deviceHeartbeat === null
        ? "system_devices.last_heartbeat_at probe failed."
        : deviceHeartbeat > 0
          ? `${deviceHeartbeat} device(s) with an authenticated heartbeat in the last 24h.`
          : "No authenticated device heartbeat in the last 24h.",
    href: "/system/kiosks",
    blocker: !db ? "Supabase backend not configured"
      : deviceHeartbeat === null ? "system_devices probe failed"
      : "Enroll + power on a device; confirm /api/devices/events records a heartbeat",
  }, now));

  const [certPhysicalPass, certPhysicalTotal] = db
    ? await Promise.all([
        countRows(db, "system_certification_runs", (q) => q.eq("tier", "physical").eq("status", "pass")),
        countRows(db, "system_certification_runs", (q) => q.eq("tier", "physical")),
      ])
    : [null, null];

  checks.push(mk({
    id: "physical_certification_passed", category: "hardware",
    label: "Physical certification passed",
    state: !db ? "pending" : certPhysicalPass === null ? "blocked"
      : certPhysicalPass > 0 ? "verified"
      : certPhysicalTotal !== null && certPhysicalTotal > 0 ? "failed" : "pending",
    evidence: !db
      ? "Supabase backend not configured."
      : certPhysicalPass === null
        ? "system_certification_runs table unreachable — check migration 0051."
        : certPhysicalPass > 0
          ? `${certPhysicalPass} physical-tier certification run(s) with status='pass' (hash-chained ledger).`
          : certPhysicalTotal !== null && certPhysicalTotal > 0
            ? `${certPhysicalTotal} physical-tier run(s) recorded, none passed.`
            : "No physical-tier certification runs recorded.",
    href: "/system/kiosks/certification",
    blocker: !db ? "Supabase backend not configured"
      : certPhysicalPass === null ? "Run migration 0051"
      : "Requires a real device + live step-up elevation — record physical checks on /system/kiosks/certification",
  }, now));

  /* ── Group + count ──────────────────────────────────────────────────── */

  const categories: AcceptanceCategory[] = ACCEPTANCE_CATEGORIES.map((c) => ({
    ...c,
    checks: checks.filter((k) => k.category === c.id),
  })).filter((c) => c.checks.length > 0);

  const counts: Record<AcceptanceState, number> = { verified: 0, pending: 0, blocked: 0, failed: 0 };
  for (const c of checks) counts[c.state]++;

  return { generatedAt: now, categories, counts };
}
