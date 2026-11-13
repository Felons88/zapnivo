# Admin activation runbook

Exact operator procedure to take the system console from "deployed" to
"first administrator active with verified MFA". Companion to the live
checklist at `/system/security/readiness` (admin checklist section) — that
page shows which items are `verified_by_code` vs `pending_manual`; this doc is
the how-to. **No secrets belong in this file or in tickets** — env var names
only.

## Prerequisites

- Production deployment live on `system.zapnivo.com` (Vercel).
- Supabase project reachable; migrations through the current manifest applied.
- Access to the Vercel project env settings and the Supabase dashboard.

## Step 1 — Bootstrap token

1. Generate a random token: `openssl rand -hex 32` (≥32 bytes).
2. Set `SYSTEM_BOOTSTRAP_TOKEN=<value>` in Vercel → Project → Settings →
   Environment Variables (Production), then redeploy.
3. Verify: `/system/security/readiness` checklist item
   `bootstrap_token` flips to `verified_by_code` (presence only — the app
   never displays the value).
4. Keep the token until bootstrap completes; rotate or remove afterwards if
   policy requires. The grant is single-use regardless.

## Step 2 — Supabase redirect URL

1. Supabase Dashboard → project → **Authentication → URL Configuration**.
2. Add `https://system.zapnivo.com/api/auth/callback` to **Redirect URLs**.
3. Add preview/deploy-host equivalents if you sign in on non-apex hosts
   (e.g. `https://<preview>.vercel.app/api/auth/callback`).
4. This cannot be verified from app code — it is dashboard state. Evidence to
   record: a completed email/OAuth sign-in on `system.zapnivo.com` in step 4.

## Step 3 — Sign in

1. Open `https://system.zapnivo.com` and sign in with the operator's email.
2. Confirm the session lands on the system console shell (you will have **no**
   `system_role` yet — that is expected; bootstrap grants it).

## Step 4 — TOTP enroll + verify

1. Go to `/system/security/mfa` (MFA & step-up).
2. Enroll a TOTP factor (scan QR into an authenticator app).
3. Complete a challenge and verify — this writes a `mfa.totp.verified` audit
   event and grants the first step-up elevation.
4. Verify on readiness: `totp_enrolled` and `mfa_verify_tested` →
   `verified_by_code`.

## Step 5 — Bootstrap grant

1. Open `/system/security/bootstrap`.
2. Submit: bootstrap token + confirmed email + current TOTP code.
3. Expected result: `profiles.system_role = 'sysadmin'` granted once;
   `system_bootstrap_grants` records consumption. The endpoint fails closed
   without the env token, rejects replay, and cannot overwrite an existing
   role.
4. Verify on readiness: `first_admin_role` → `verified_by_code`.

## Step 6 — Fresh session

1. Sign out and sign back in so the new `system_role` is loaded.
2. Confirm `/system` dashboard renders with sysadmin permissions.

## Step 7 — Elevation test (manual)

1. Trigger any privileged action requiring step-up (e.g. publish a CMS field
   or a deployments.manage operation).
2. Complete the TOTP challenge.
3. Verify a `system_elevations` row exists with `method='totp'` and ~15-minute
   expiry; confirm the action then succeeds.
4. Readiness item `step_up_elevation` → `verified_by_code`.

## Step 8 — Session revoke test (manual)

1. From `/system/security/sessions` (or via `identity.revokeUserSessions`),
   revoke a test session.
2. Confirm the revoked session's cookie stops working immediately (request
   returns 401) and that an active elevation does not resurrect it.
3. Record the attestation on the readiness checklist item
   `session_revocation_tested` (stays `pending_manual` until a human
   confirms — audit rows alone do not prove access ended).

## Step 9 — Access-control spot check (manual)

Exercise the `system.*` permission matrix as each role on the live deployment;
denied actions must return 403. Record results for
`access_control_tests` on the readiness page.

## Step 10 — Provider activation (optional, per need)

`GET /api/system/activation` (or the integrations pages) reports per-provider
state. For each provider you intend to use:

1. Set the required env vars (names shown under `missing`) in Vercel, redeploy.
2. Run the live health check (`/api/system/integrations/<id>/health`) until it
   reports `operational` — env presence alone is **not** verification.
3. Configure webhooks where applicable (Stripe signing secret, Brevo inbound
   secret, Supabase redirect URL from step 2).
4. Record the `verifiedAt` timestamp and check `lastOperation` for real
   traffic before declaring the provider activated.

The `newsletter-mail` provider activates automatically once `BREVO_API_KEY`
or `RESEND_API_KEY` is set **and** the corresponding provider verifies —
verification evidence is borrowed from the brevo/resend health checks.

## Evidence to record

- Readiness checklist screenshot/URL after each verified step.
- `system_audit_events` rows: `mfa.totp.verified`, `sitecms.*`/`cms.selftest`,
  bootstrap grant consumption.
- Activation probe output (`GET /api/system/activation`) once providers are
  live — `credentialVerified: true` entries with `verifiedAt` timestamps.
- Manual attestations for `session_revocation_tested` and
  `access_control_tests` (these never auto-pass).
