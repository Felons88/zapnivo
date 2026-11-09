# Security checklist

Status key: ✅ implemented · ⏳ designed, pending integration · ⛔ blocked (needs third party / hardware)

## Payments
- ⛔ Stripe integration not wired — no payment code paths are active. When added:
  - ⏳ Server-side-only price lookup via `pricing_versions` (client never supplies prices).
  - ⏳ Webhook signature validation + idempotent processing keyed on `stripe_payment_intent_id` (UNIQUE).
  - ⏳ Auth-then-capture: only final rental amount captured; authorization released on failed dispense.
- ✅ No card fields exist anywhere; `looksLikeCardNumber` rejects submissions containing card-like digits.
- ✅ `SUPABASE_SERVICE_ROLE_KEY` and `STRIPE_SECRET_KEY` are server-only (no `NEXT_PUBLIC_`).

## Hardware commands
- ✅ Dispense abstraction in `src/lib/kiosk/adapter.ts`; `NullKioskAdapter` always fails safe.
- ✅ `device_commands.idempotency_key` UNIQUE — retried commands can't double-dispense.
- ⛔ Real dispense protocol blocked until manufacturer docs + device inspection.
- ⏳ Remote commands restricted to `admin` role (`device_commands` policy) + audit logging.

## Auth & access control
- ✅ `/admin` + `/partners` verified server-side each request (Supabase `getUser` + `profiles.role`); roles are read fresh per request, never baked into the cookie.
- ✅ Partners scoped to own `organization_id` via RLS; staff-only tables deny non-staff JWTs.
- ✅ Intake tables (applications, tickets, messages) insertable only via service-role API routes.
- ✅ Login rate-limited (8/10 min per IP), cookie is httpOnly + sameSite=lax.
- ⏳ Admin MFA: `profiles.mfa_required` column exists; enforce via Supabase MFA policies before launch.

## Live-audit results (2026-11-09, against the linked project)
- ✅ Anon key: every sensitive table returns 0 rows; inserts (incl. role-escalation attempt) rejected 42501; no buckets listable.
- ✅ **Privilege escalation fixed** (migrations 0005–0006): a customer could previously self-promote to `admin` via `profiles` self-update — now SELECT-only for non-staff, plus a `profiles_guard` trigger that blocks `role`/`organization_id`/`mfa_required` changes from any non-service JWT. Verified with real users: customer and partner escalation attempts leave the role unchanged.
- ✅ **Partner tampering fixed**: partners can still *read* their own venues/agreements/ledgers, but verified they cannot rewrite agreement terms, venue rows, or any financial data (only select policies remain).
- ✅ **Service-only writes**: every JWT policy is now SELECT-only — even an admin's own token cannot forge a refund, flip internal notes public, or delete tickets. Grant-level `revoke insert/update/delete` on `anon`/`authenticated` (incl. default privileges for future tables) is belt-and-suspenders. All mutations flow through the service layer, which validates, authorizes, and audit-logs.
- ✅ Verified after lockdown: ticket creation through the app still works (service path unaffected); test rows cleaned up.

## Input & abuse
- ✅ Zod validation on every public form endpoint; shared `handleSubmission` pipeline.
- ✅ Honeypot field silently drops bots; per-IP rate limits on all POST routes.
- ✅ Origin/host check rejects cross-origin POSTs; attachments limited to real JPG/PNG/WebP ≤5 MB (magic bytes).
- ✅ RLS enabled on every table; anonymous users get no direct table access.

## Transport & headers
- ✅ `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS via `next.config.ts`.
- ✅ CSP deployed: `connect-src` limited to our origin + Supabase + Mapbox (exfil guard), `frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self'`. `unsafe-inline` scripts required by Next; `unsafe-eval` only in dev.

## Ops
- ⏳ Error monitoring (Sentry/similar), structured log shipping — `console.error` JSON in place as seam.
- ⏳ Backups: Supabase PITR plan + restore drill before launch.
- ⏳ Secrets rotation procedure to document once providers are chosen.

## Support lookups
- ✅ Rental lookup needs an exact receipt-email match (no search without it); identical response for not-found vs. someone else's rental.
- ✅ Rate limited per IP (12/15 min) and per email (6/15 min); ticket status per IP and per ticket number.
- ✅ Response is a customer-safe projection (no emails, internal IDs, card data); search windows capped at 48h; references validated `ZR-XXXXXXXX`.
- ✅ Internal support notes are never returned by ticket tracking (`internal = false` only).
- ⏳ Integration-test the lookup queries against a real Supabase project before launch.

## AI assistant
- ✅ `OPENROUTER_API_KEY` is server-only; the browser only talks to `/api/support/assistant`.
- ✅ Card-like text is blocked before it reaches the model; input capped (12 messages × 1,000 chars); 20 req / 10 min per IP; same-origin only.
- ✅ The model can only call lookup_rental with an email the customer typed in the conversation, and lookups use the same guarded service (exact email match, rate limits, customer-safe projection).
- ✅ System prompt forbids promising refunds, disclosing partner financial terms, and inventing facts; rental amounts are shown from tool results as cards.
- ⏳ Prompt-injection / jailbreak evaluation against the chosen model before launch.
- ⏳ Name the AI provider and retention in the Privacy Policy (draft flagged [REVIEW]).
