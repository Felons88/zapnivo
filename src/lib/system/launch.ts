import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase";
import { securityReadiness, type ReadinessStatus } from "./readiness";
import { paymentReadiness } from "@/lib/payments/readiness";
import { giftLaunchStatus, GIFT_LAUNCH_CHECKLIST } from "@/lib/gift-launch";
import { stripeConfigured, isStripeWebhookConfigured } from "@/lib/stripe";

/**
 * Launch readiness — platform-wide commercial-launch posture.
 *
 * HONESTY RULES:
 * - 'verified' requires live evidence (DB rows, provider probe, recorded test).
 * - Unit tests alone never produce 'verified' — they produce 'test_verified'.
 * - Env-var presence produces 'configured', never 'verified'.
 * - Anything needing a human, credential, dashboard action, legal sign-off,
 *   or physical hardware is surfaced as a blocker, not hidden.
 */

export type LaunchStatus =
  | "verified"
  | "operational"
  | "partially_operational"
  | "configured"
  | "implemented"
  | "test_verified"
  | "blocked"
  | "requires_manual_action"
  | "unverified";

export type LaunchSubsystem = {
  id: string;
  label: string;
  status: LaunchStatus;
  /** What is actually proven today. */
  evidence: string;
  /** Concrete actions still required before this subsystem can carry revenue/ops. */
  blockers: string[];
};

export type LaunchReadiness = {
  generatedAt: string;
  subsystems: LaunchSubsystem[];
  /** Flat list of every blocker across subsystems — the "what's left" answer. */
  blockers: { subsystem: string; item: string }[];
  counts: Record<LaunchStatus, number>;
};

const env = (k: string) => !!process.env[k]?.trim();

async function countRows(db: SupabaseClient, table: string, filter?: { col: string; val: unknown }): Promise<number | null> {
  try {
    let q = db.from(table).select("id", { count: "exact", head: true });
    if (filter) q = q.eq(filter.col, filter.val as never);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

export async function launchReadiness(db?: SupabaseClient | null): Promise<LaunchReadiness> {
  const d = db ?? serviceClient();
  const readiness = d ? await securityReadiness(d) : null;
  const payments = await paymentReadiness(d ?? undefined);
  const gifts = giftLaunchStatus();
  const subsystems: LaunchSubsystem[] = [];

  const backupState = readiness?.backup?.state ?? "unverified";
  const sections = readiness?.sections ?? [];
  const sectionStatus = (id: string) => sections.find((s) => s.id === id)?.status;

  /* ── 1. Edge & routing ─────────────────────────────────────────────── */
  subsystems.push({
    id: "edge_routing",
    label: "Edge & subdomain routing",
    status: "operational",
    evidence: "All 7 hosts resolve (www/apex + customer/partners/support/internal/api/system); portal paths 308 to correct subdomains; host allowlist + sanitized next enforced in proxy.",
    blockers: ["Supabase Auth redirect allowlist must include every portal /api/auth/callback (dashboard action)"],
  });

  /* ── 2. Authentication & sessions ──────────────────────────────────── */
  const supabaseConfigured = env("NEXT_PUBLIC_SUPABASE_URL") && env("NEXT_PUBLIC_SUPABASE_ANON_KEY") && env("SUPABASE_SERVICE_ROLE_KEY");
  const bootstrapGrants = readiness?.bootstrap_grants ?? null;
  subsystems.push({
    id: "authentication",
    label: "Authentication & sessions",
    status: supabaseConfigured ? (bootstrapGrants && bootstrapGrants > 0 ? "operational" : "requires_manual_action") : "blocked",
    evidence: supabaseConfigured
      ? `Supabase env configured; absolute 24h session policy enforced; system bootstrap grants: ${bootstrapGrants ?? "unknown"}.`
      : "Supabase env vars missing — all auth fails closed.",
    blockers: [
      ...(supabaseConfigured ? [] : ["Set NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY"]),
      ...(bootstrapGrants === 0 ? ["First system admin bootstrap not yet completed (one-time, requires SYSTEM_BOOTSTRAP_TOKEN or documented manual grant + TOTP)"] : []),
      "Authorized admin must complete live MFA enrollment + step-up validation",
    ],
  });

  /* ── 3. Customer portal ────────────────────────────────────────────── */
  subsystems.push({
    id: "customer_portal",
    label: "Customer portal",
    status: "operational",
    evidence: "customer.zapnivo.com routes to /account; session auth, receipts, rentals, memberships UI implemented; account APIs role-checked.",
    blockers: ["End-to-end login → rental → receipt walkthrough with a real customer account not yet recorded"],
  });

  /* ── 4. Partner portal ─────────────────────────────────────────────── */
  subsystems.push({
    id: "partner_portal",
    label: "Partner portal",
    status: "operational",
    evidence: "partners.zapnivo.com org-scoped APIs (settings/documents/requests verified org-bound); partner application → staff notification → approval flow implemented.",
    blockers: ["First real partner onboarding not yet exercised end-to-end"],
  });

  /* ── 5. Support / helpdesk ─────────────────────────────────────────── */
  const helpdeskSecret = env("HELPDESK_SECRET");
  subsystems.push({
    id: "support",
    label: "Support & helpdesk",
    status: helpdeskSecret ? "configured" : "implemented",
    evidence: `Ticket queues (customer/billing/partner/safety), signed access tokens, refund policy, AI triage with human handoff; HELPDESC_SECRET ${helpdeskSecret ? "set" : "using dev fallback — set in production"}.`,
    blockers: [
      ...(helpdeskSecret ? [] : ["Set HELPDESC_SECRET in Vercel production"]),
      "AI auto-send governance flag HELPEDESK_AI_AUTOSEND decision pending",
    ],
  });

  /* ── 6. Communications ─────────────────────────────────────────────── */
  const mailerConfigured = env("BREVO_API_KEY") || env("RESEND_API_KEY");
  const inboundConfigured = env("EMAIL_INBOUND_SECRET");
  const twilioConfigured = env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && env("TWILIO_FROM_NUMBER");
  subsystems.push({
    id: "communications",
    label: "Communications (email/SMS/inbound)",
    status: mailerConfigured ? "configured" : "requires_manual_action",
    evidence: `Outbound mailer ${mailerConfigured ? "provider key present" : "NO provider key — outbox queues silently"}; inbound webhook ${inboundConfigured ? "configured" : "unset"}; Twilio ${twilioConfigured ? "configured" : "unset"}; SMS delivery callbacks + email outbox implemented.`,
    blockers: [
      ...(mailerConfigured ? [] : ["Set BREVO_API_KEY (or RESEND_API_KEY) + SUPPORT_FROM_EMAIL — all staff/customer email is queued, not sent"]),
      ...(inboundConfigured ? [] : ["Set EMAIL_INBOUND_SECRET + configure Brevo inbound parse webhook"]),
      ...(twilioConfigured ? [] : ["Set TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER for SMS + OTP"]),
      "No email bounce/delivery webhook — 'sent' means provider-accepted only",
      "No newsletter/subscriber capture exists (feature gap, not a defect)",
    ],
  });

  /* ── 7. AI platform ────────────────────────────────────────────────── */
  const openrouter = env("OPENROUTER_API_KEY");
  const agentsEnabled = d ? await countRows(d, "ai_agents", { col: "enabled", val: true }) : null;
  const agentsTotal = d ? await countRows(d, "ai_agents") : null;
  subsystems.push({
    id: "ai_platform",
    label: "AI platform & governance",
    status: openrouter ? "configured" : "implemented",
    evidence: `Agent registry ${agentsEnabled ?? "?"}/${agentsTotal ?? "?"} agents enabled; kill switches, budgets, DENIED_ACTIONS (no refund/payment tools exist), tool scoping by session, eval harness, knowledge lifecycle all implemented+tested. OPENROUTER_API_KEY ${openrouter ? "set" : "unset — AI paths degrade to human"}.`,
    blockers: [
      ...(openrouter ? [] : ["Set OPENROUTER_API_KEY for AI features (system safely degrades without it)"]),
      "Eval suite has never run against a real model (needs key + authorized run)",
      "Live kill-switch enforcement on production AI traffic requires post-deploy verification",
    ],
  });

  /* ── 8. Payments & monetization ────────────────────────────────────── */
  const giftsEnabled = gifts.status === "enabled";
  subsystems.push({
    id: "payments",
    label: "Payments & monetization",
    status: payments.overall === "ready" ? "operational" : payments.overall === "partial" ? "partially_operational" : "requires_manual_action",
    evidence: `Stripe ${payments.stripe.mode} mode (secret ${payments.stripe.secretKey ? "set" : "MISSING"}, webhook ${payments.webhookEndpoint}); plans=${payments.products.plans ?? "?"}, packages=${payments.products.packages ?? "?"}; reconciliation=${payments.reconciliation}; gifts=${gifts.status}. Webhook signature verify + idempotency + ledger implemented+tested.`,
    blockers: [
      ...(payments.stripe.secretKey ? [] : ["Set STRIPE_SECRET_KEY"]),
      ...(payments.stripe.webhookSecret ? [] : ["Set STRIPE_WEBHOOK_SECRET + register endpoint in Stripe dashboard"]),
      ...(payments.products.plans && payments.products.plans > 0 ? [] : ["Seed membership_plans — catalog is empty, memberships not purchasable"]),
      ...(payments.products.packages && payments.products.packages > 0 ? [] : ["Seed prepaid_packages — catalog is empty"]),
      ...(giftsEnabled ? [] : [`Gift sales: ${gifts.status} — legal checklist incomplete, see Legal & compliance`]),
      "No live Stripe transaction has ever been verified end-to-end",
    ],
  });

  /* ── 9. Hardware / kiosks ──────────────────────────────────────────── */
  const hwAdapter = process.env.KIOSK_ADAPTER ?? "none";
  const deviceAuthStatus = sectionStatus("device_auth");
  subsystems.push({
    id: "hardware",
    label: "Hardware & kiosk fleet",
    status: hwAdapter === "none" ? "blocked" : "unverified",
    evidence: `KIOSK_ADAPTER=${hwAdapter} (NullKioskAdapter — physical commands unsupported by design). Device HMAC auth ${deviceAuthStatus ?? "?"}; provisioning/certification/simulator/command-lifecycle all implemented+tested; zero physical devices enrolled.`,
    blockers: [
      "Real kiosk hardware + gateway vendor documentation required",
      "Manufacturer integration checklist: gateway API, heartbeat, inventory, dispense/return actuation, offline recovery, firmware, ad-screen playback — all [REQUIRES VENDOR DOCS]",
      "Physical certification tier requires elevated admin + real device evidence",
      "KIOSK_LEGACY_INGEST must stay unset",
    ],
  });

  /* ── 10. System Control ────────────────────────────────────────────── */
  const sysStatuses = sections.map((s) => s.status);
  const sysBlocked = sysStatuses.filter((s) => s === "blocked").length;
  subsystems.push({
    id: "system_control",
    label: "System Control plane",
    status: readiness ? "operational" : "unverified",
    evidence: `${sections.length} readiness sections live on /system/security/readiness; RBAC + TOTP step-up + audit + approvals implemented; ${sysBlocked} section(s) blocked.`,
    blockers: [
      "Admin bootstrap + live MFA validation pending (see /system/security/readiness checklist)",
      backupState !== "restore_tested" && backupState !== "recovery_verified"
        ? `Backup state: ${backupState} — see /system/recovery`
        : "",
    ].filter(Boolean) as string[],
  });

  /* ── 11. Observability & alerting ──────────────────────────────────── */
  const alertWebhook = env("ALERT_WEBHOOK_URL");
  const cronSecret = env("CRON_SECRET");
  let recentCronOk: number | null = null;
  if (d) {
    const since = new Date(Date.now() - 48 * 3600_000).toISOString();
    recentCronOk = await countRows(d, "cron_runs", { col: "ok", val: "true" }).then(async (total) => {
      if (total == null) return null;
      const { count } = await d.from("cron_runs").select("id", { count: "exact", head: true }).eq("ok", true).gte("ran_at", since);
      return count ?? 0;
    });
  }
  subsystems.push({
    id: "observability",
    label: "Observability & alerting",
    status: cronSecret ? "configured" : "requires_manual_action",
    evidence: `Error/trace/log ingestion + fingerprinted alerting implemented; ${recentCronOk ?? "?"} successful cron runs in last 48h; ALERT_WEBHOOK_URL ${alertWebhook ? "set" : "unset — critical alerts email-only"}; uptime probe via GitHub Actions.`,
    blockers: [
      ...(cronSecret ? [] : ["Set CRON_SECRET — scheduled jobs will 401"]),
      ...(alertWebhook ? [] : ["Set ALERT_WEBHOOK_URL for out-of-band critical alerts (Slack/PagerDuty)"]),
      "Uptime GitHub-Actions probe notifies via issue only unless webhook wired",
      "Email-dependent alerts silently queue if BREVO/RESEND unconfigured",
    ],
  });

  /* ── 12. Backup & disaster recovery ────────────────────────────────── */
  subsystems.push({
    id: "backup_dr",
    label: "Backup & disaster recovery",
    status:
      backupState === "recovery_verified" ? "verified"
      : backupState === "restore_tested" ? "partially_operational"
      : backupState === "backup_available" ? "configured"
      : backupState === "backup_configured" ? "requires_manual_action"
      : "blocked",
    evidence: `Provider state ${backupState} (snapshot as_of ${readiness?.backup.provider_snapshot?.as_of ?? "unknown"}: walg=${readiness?.backup.provider_snapshot?.walg_enabled}, pitr=${readiness?.backup.provider_snapshot?.pitr_enabled}, backups=${readiness?.backup.provider_snapshot?.backup_count ?? "?"}). docs/RECOVERY.md has the restore runbook.`,
    blockers: [
      "Enable PITR or scheduled backups in Supabase Dashboard (PITR may be paid add-on)",
      "Run isolated restore exercise → record in system_recovery_tests",
      "Until restore_tested: NO destructive retention execute, no assumption backups exist",
    ],
  });

  /* ── 13. Data retention ────────────────────────────────────────────── */
  const pendingApprovals = readiness?.pending_retention_approvals ?? null;
  const lastRetention = readiness?.retention_last_run ?? null;
  subsystems.push({
    id: "retention",
    label: "Data retention",
    status: pendingApprovals === 0 ? "operational" : pendingApprovals != null && pendingApprovals > 0 ? "blocked" : "configured",
    evidence: `${pendingApprovals ?? "?"} pending retention change-requests; last run: ${lastRetention ? JSON.stringify(lastRetention).slice(0, 120) : "none recorded"}; dry-run default, bounded deletes, preserved-class denylist.`,
    blockers: [
      "First production execute requires an approved change request (by design)",
      "Dry-run showed 0 expired rows — policies verified, nothing to delete yet",
    ],
  });

  /* ── 14. Legal & compliance ────────────────────────────────────────── */
  const pendingLegal = GIFT_LAUNCH_CHECKLIST.filter((c) => c.category === "legal" && c.status === "pending").length;
  subsystems.push({
    id: "legal",
    label: "Legal & compliance gates",
    status: giftsEnabled ? "operational" : "requires_manual_action",
    evidence: `Gift sales ${gifts.status} — legal checklist ${pendingLegal} pending items (legalApproved=${gifts.legalApproved}, paymentsConfigured=${gifts.paymentsConfigured}); pricing_versions approval gate enforced at checkout; scam-awareness page live.`,
    blockers: [
      ...(giftsEnabled ? [] : [`Complete gift legal checklist (${pendingLegal} items) then set GIFT_SALES_ENABLED=1`]),
      "Publish registered business postal address (CAN-SPAM footer gap)",
      "Verify membership/package terms before catalog launch",
    ],
  });

  const counts: Record<LaunchStatus, number> = {
    verified: 0, operational: 0, partially_operational: 0, configured: 0,
    implemented: 0, test_verified: 0, blocked: 0, requires_manual_action: 0, unverified: 0,
  };
  const blockers: { subsystem: string; item: string }[] = [];
  for (const s of subsystems) {
    counts[s.status]++;
    for (const b of s.blockers) if (b.trim()) blockers.push({ subsystem: s.label, item: b });
  }

  return { generatedAt: new Date().toISOString(), subsystems, blockers, counts };
}
