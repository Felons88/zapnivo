export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";

export const metadata: Metadata = { title: "Security — Policy" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-3 space-y-2 text-sm text-slate-300">{children}</div>
    </section>
  );
}

/**
 * Static, honest policy page — documents what IS enforced in code today.
 * Anything not yet implemented is labeled as such rather than implied.
 */
export default function SystemPolicyPage() {
  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-lime">Security</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Security policy & posture</h1>
          <p className="mt-1 text-sm text-slate-400">
            What is actually enforced today — read from the codebase, not aspirational. Related views:{" "}
            <Link href="/system/security/audit" className="text-lime underline">audit log</Link>,{" "}
            <Link href="/system/security/users" className="text-lime underline">system users</Link>,{" "}
            <Link href="/system/security/sessions" className="text-lime underline">sessions</Link>.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Session lifetime — ENFORCED">
            <p>
              Absolute <strong className="text-slate-100">24-hour session ceiling</strong>, anchored to first-seen
              authentication in <code className="font-mono text-xs">auth_sessions</code> (migration 0028). Supabase
              refresh tokens mint new JWT <code className="font-mono text-xs">iat</code> values and cannot extend the
              deadline — the registry row is authoritative.
            </p>
            <p>
              Two paths: <code className="font-mono text-xs">sso:&lt;session_id&gt;</code> registry rows for Supabase
              sessions, and a signed anchor-cookie fallback (<code className="font-mono text-xs">authAtMs</code>) that
              rejects JWTs older than the ceiling even if the cookie is fresh.
            </p>
            <p>
              Logout calls <code className="font-mono text-xs">revokeCurrentSession()</code> which sets{" "}
              <code className="font-mono text-xs">revoked_at</code>. Registry unavailable → protected routes fail closed.
            </p>
          </Section>

          <Section title="System access tier — ENFORCED">
            <p>
              <code className="font-mono text-xs">profiles.system_role</code> is a separate tier from business roles —
              business admin/staff get <strong className="text-slate-100">no</strong> system access automatically.
              Roles: viewer, developer, hardware, engineer, security, sysadmin, breakglass.
            </p>
            <p>
              Permission strings are code-defined (<code className="font-mono text-xs">src/lib/system/rbac.ts</code>);
              the DB stores only the role. Every system page declares its permission via{" "}
              <code className="font-mono text-xs">&lt;SystemGate perm="…"&gt;</code>; every mutation route runs{" "}
              <code className="font-mono text-xs">systemApiGuard</code> + rate limit + audit.
            </p>
            <p>
              <strong className="text-slate-100">Breakglass</strong>: every mutation requires an approved change request
              decided by a different principal (separation of duties). High/critical-risk actions require approval for
              any role. Self-approval and self-role-modification are blocked.
            </p>
          </Section>

          <Section title="Audit trail — ENFORCED">
            <p>
              <code className="font-mono text-xs">system_audit_events</code> is append-only (select-only RLS; writes via
              service role only). Detail payloads are size-capped and secret-scrubbed — keys matching
              pass/secret/token/key/auth/cookie/otp/card are dropped before insert.
            </p>
            <p>
              Observability telemetry (<code className="font-mono text-xs">error_events</code>,{" "}
              <code className="font-mono text-xs">app_logs</code>, <code className="font-mono text-xs">trace_spans</code>)
              is scrubbed of emails, phones, tokens, card numbers and secret-looking keys before storage.
            </p>
          </Section>

          <Section title="Secrets handling — ENFORCED">
            <p>
              Service-role keys and Stripe secrets are server-only — never <code className="font-mono text-xs">NEXT_PUBLIC_</code>,
              never imported by client components. This console reports secret <em>presence</em> only
              (e.g. <code className="font-mono text-xs">OPENROUTER_API_KEY ✓</code>) — values are never read into pages or APIs.
            </p>
            <p>
              Forms across the platform go through <code className="font-mono text-xs">handleSubmission</code> (zod +
              honeypot + rate limit + card-number guard). System API routes are zod-validated and per-user rate-limited.
            </p>
          </Section>

          <Section title="Multi-factor authentication — NOT YET ENFORCED">
            <p>
              <code className="font-mono text-xs">profiles.mfa_required</code> exists as a flag column and the DB trigger
              blocks non-service-role changes to it, but <strong className="text-amber-300">no TOTP/WebAuthn
              implementation exists in the codebase</strong> — the flag is not backed by a second factor.
            </p>
            <p className="text-amber-200/80">
              Status: requires implementation. Do not treat mfa_required=true as real MFA coverage until a TOTP
              enrollment + challenge flow ships.
            </p>
          </Section>

          <Section title="Session revocation — PARTIAL">
            <p>
              Self-service revocation on logout works (<code className="font-mono text-xs">revoked_at</code>). There is{" "}
              <strong className="text-amber-300">no admin endpoint to terminate an arbitrary user's session</strong> —
              requires implementation if immediate offboarding termination is needed.
            </p>
            <p>
              Password/credential reset flows invalidate sessions only indirectly (via Supabase); forced global
              sign-out is not wired to the registry — requires implementation.
            </p>
          </Section>

          <Section title="Data access boundaries — ENFORCED">
            <p>
              RLS everywhere; service-role bypasses only in server code. Observability tables are staff-read via RLS
              and service-role write. The system plane uses its own role tier so business staff cannot reach it.
            </p>
            <p>
              Agent guardrails: <code className="font-mono text-xs">canRun()</code> enforces enabled flag, hourly caps and
              budgets; consequential actions route through <code className="font-mono text-xs">ai_approvals</code> with a
              denied-action list that can never be auto-approved.
            </p>
          </Section>

          <Section title="External monitoring — LIVE">
            <p>
              <code className="font-mono text-xs">.github/workflows/uptime.yml</code> probes all Zapnivo properties every
              ~15 min from GitHub Actions — independent of Vercel, so it still fires when the app is down — and maintains
              a deduplicated incident issue. In-app probes run via <code className="font-mono text-xs">/api/cron/uptime</code>{" "}
              (CRON_SECRET bearer) into <code className="font-mono text-xs">uptime_checks</code>; 3 consecutive failures
              auto-create incidents.
            </p>
          </Section>
        </div>
      </div>
    </SystemGate>
  );
}
