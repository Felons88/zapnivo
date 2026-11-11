# Platform integration & recovery gap audit

Audited: HEAD `d551e94` ("Monetization phase 3: atomic redemption, credit settlement, gift delivery, group funding").
Working tree clean (`git status` empty) — no uncommitted receptionist/finance-investigation work present at audit time.
Scope: read-only audit of committed state. No `src/`, `supabase/`, or `tests/` files were modified.

---

## 1. Repository state

| Item | State | Evidence |
|---|---|---|
| HEAD commit | `d551e94` Monetization phase 3 | `git log --oneline -10` |
| Working tree | Clean | `git status --short` → empty |
| Migrations | 36 files, `0001`–`0037` (**`0018` is skipped** — numbering gap, likely intentional/renamed) | `supabase/migrations/` |
| Test suite | **54 files / 616 tests, all passing** (~4.3s) | `npm test` (vitest) |
| Typecheck | **Clean** (`tsc --noEmit`, 0 errors) | `npm run typecheck` |
| Production build | **Unverified** — stale `.next/BUILD_ID` artifact exists (`-C4ZqOWbOatwet1eFp7GT`); `next build` not re-run during audit | `.next/` |
| Payment SDKs | None — Stripe/Twilio/Brevo/Resend/OpenRouter all called via plain `fetch` REST | `src/lib/stripe.ts`, `src/lib/sms.ts`, `src/lib/helpdesk/mailer.ts`, `src/lib/ai/openrouter.ts` |

### Migration inventory (what each creates)

| Migration | Creates |
|---|---|
| 0001_init | Core schema: organizations, profiles, venues, venue_contacts, kiosks, kiosk_slots, power_banks, device_events, device_commands, maintenance_visits, pricing_versions, rentals, payments, refunds, disputes, partner_agreements, commission_ledgers, payout_records, partner_applications, advertising_inquiries, contact_messages, support_tickets/messages, advertising_campaigns/assets, playback_events, audit_logs, system_config + `handle_new_user`, `my_role`, `is_staff` |
| 0002–0003 | Support lookup indexes; payment refund totals |
| 0004_helpdesk | ticket_events, refund_requests, email_outbox + RLS |
| 0005–0006 | Security lockdown: privilege-change block, staff-read-only policies (service-role writes) |
| 0007–0009 | outbox HTML; ops tooling (internal_notes, notification_prefs, saved_views, installation_files, cron_runs); partner onboarding steps + document requests |
| 0010_payments | stripe_events (dedupe), promo_codes + `redeem_promo`/`release_promo` RPCs |
| 0011–0017 | incident_reports; sms_messages; notification_jobs + sms_templates; phone_otps; kiosk_events; billing_ledger; customer_data_requests |
| 0019–0024 | sms_opt_outs; phone_claims; email_outbox sender index; inbound_emails; inbound_jobs (durable queue); customer realtime RLS (own tickets/messages) |
| 0025–0026 | business_events; observability (error_events, error_issues, app_logs, trace_spans, incidents, uptime_checks) |
| 0027_business_expansion | advertiser_orgs/members, ad_creatives, ad_rate_cards, ad_ledger, ad_events, sponsor_campaigns, sponsored_redemptions, membership_plans, customer_memberships, gift_credits + member/public RLS |
| 0028_auth_sessions | auth_sessions (24h session registry) |
| 0029_intelligence | ai_agents, ai_agent_runs, ai_approvals, knowledge_articles/versions, experiments(+variants/assignments), eval_suites/runs |
| 0030 | analytics_daily, analytics_cohorts |
| 0031_monetization | entitlement_grants/events, `redeem_entitlement`, `grant_entitlement`, `expire_entitlements`, prepaid_packages, package_purchases, rental_groups |
| 0032–0033 | event_passes columns, event price |
| 0034_atomic_ops | entitlement_reservations; `reserve_entitlement`, `commit_entitlement`, `release_entitlement`, `release_rental_reservations`, `redeem_event_pass`, `claim_gift` RPCs |
| 0035–0037 | `adjust_group_credit`, `commit_entitlement_partial`, `issue_event_pass` RPCs |

### Environment (`.env.local` — key NAMES only, values not read)

Present: `BREVO_API_KEY`, `EMAIL_INBOUND_SECRET`, `HELPDESK_SECRET`, `KIOSK_ADAPTER` (= `none`-ish value), `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPPORT_FROM_EMAIL`.

Absent locally (must live in Vercel env — **Vercel status unknown/unverified**): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_TAX_ENABLED`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `RESEND_API_KEY`, `KIOSK_INGEST_SECRET`, `CRON_SECRET`, `ALERT_WEBHOOK_URL`, `NEXT_PUBLIC_MAPBOX_TOKEN`, `GIFT_SALES_ENABLED`, `HELPDESK_DEV_STORE`.

`.env.example` documents all of the above (`grep` confirms names). Commit `07685e4` ("redeploy to pick up KIOSK_INGEST_SECRET env") implies Vercel env provisioning is done incrementally outside the repo.

---

## 2. Feature inventory matrix

Status legend: **operational** = code complete + env present + exercised; **implemented-unverified** = code complete, blocked on env/live DB/external service; **partial** = some paths work, others stubbed/missing; **disabled** = intentionally off; **blocked** = cannot function without third party; **missing** = not built.

| Area | Status | Evidence | Blocker | Risk |
|---|---|---|---|---|
| Website / SEO | **operational** | `src/app/sitemap.ts`, `robots.ts`, `llms.txt`, `llms-full.txt`, `opengraph-image.tsx`, legal pages under `(site)/legal/`; tests `seo.test.ts`, `sitemap.test.ts`, `legal-content.test.ts` | Real photography still "Illustrative render" (`components/Illustrations.tsx`, `public/images/*.png`) | Low — content/legal pages are owner-approval drafts (`docs/LAUNCH-READINESS.md` item 13) |
| Customer rental checkout | **blocked** (code complete) | `src/app/api/rentals/checkout/route.ts` (503 `payments_unconfigured` without `STRIPE_SECRET_KEY`), `src/lib/stripe.ts` `createCheckoutSession` (manual capture hold) | `STRIPE_SECRET_KEY` absent locally; Vercel unknown | **P0** — no revenue until Stripe keys live |
| Auth + 24h sessions | **implemented-unverified** | `src/lib/auth.ts` (`SESSION_MAX_AGE_MS = 24h`, `auth_sessions` registry, anchor-cookie fallback), migration 0028, `api/auth/{login,email-link,google,phone,callback}` | Supabase env present locally; live behavior unverified | Medium — session registry fail-closed on DB errors |
| Phone OTP | **implemented-unverified** | `src/app/api/auth/phone/route.ts`, migration 0014 `phone_otps`, `src/lib/sms.ts` | `TWILIO_*` absent locally → `delivered:false` honest fallback in `LoginForm.tsx` | Medium — OTP "sent" but undelivered until Twilio creds set |
| Gifts (purchase) | **disabled** | `src/lib/gifts.ts` `giftSalesEnabled()` requires `GIFT_SALES_ENABLED=1` (unset → purchases closed by design); `GIFT_PACKAGES` are unapproved seed prices | Env flag + Stripe + owner pricing approval | Low (intentional) |
| Gifts (claim/redeem) | **implemented-unverified** | `api/gifts/{route,redeem,claim,[id]}`, `lib/gifts-delivery.ts` (72h one-time claim token, sha256-only storage), `claim_gift` RPC (0034), code redemption `XXXX-XXXX-XXXX` | Requires paid `gift_credits` row → needs Stripe webhook | See gap §3.4/§3.5 |
| Memberships | **implemented-unverified** | `membership_plans`/`customer_memberships` (0027), checkout + cancel routes (`api/monetization/membership/*`), recurring subscriptions via `createSubscriptionCheckout`, benefit grants in `lib/monetization/webhook.ts` | **No seed data** — `membership_plans` is empty until an admin inserts via `api/admin/monetization/plans` (no migration seeds it) | Medium — catalog renders empty; benefit→grant mapping unverified live |
| Groups | **implemented-unverified** | `src/lib/groups.ts`, `api/groups/**` (invite/claim/fund/close/remove), `rental_groups`, `group_credit_purchases`, `adjust_group_credit` RPC | Group funding needs Stripe; comment in `groups.ts` header is **stale** (says "staff fund manually" but `api/groups/[id]/fund` is self-serve checkout) | Low |
| Events | **implemented-unverified** | `src/lib/events-program.ts`, `api/events/**`, `event_passes`, `issue_event_pass`/`redeem_event_pass` RPCs (0034/0037), `api/events/passes/[id]/checkout` | Needs Stripe for paid passes; free passes possible | Low |
| Credits settlement | **implemented-unverified** | `src/lib/monetization/credits.ts` (reserve→commit_partial→release), `applyCreditsAtSettlement` in `api/rentals/[id]/route.ts:123`, `entitlement_reservations` (0034), `commit_entitlement_partial` (0036) | Live DB verification pending; best-effort by design (never blocks settlement) | Medium — credit math is the most complex new surface; 9+4 dedicated tests pass |
| Partners | **implemented-unverified** | `src/app/partners/**` (portal, onboarding, documents, payouts, support), `lib/partner-ops*.ts`, migration 0009, partner RLS policies | Live Supabase + real partner accounts | Low |
| Advertising / sponsored charging | **implemented-unverified** | `lib/ads/*`, `api/advertiser/**`, migration 0027 ad tables, `createAdCheckoutSession`, sponsored redemption recorded at checkout (`api/rentals/checkout/route.ts:89-100`) and discounted at settlement (`api/rentals/[id]`) | Stripe for campaign prepayment; ad creatives/playback need kiosk ingest secret | Medium — ad ledger correctness unverified against live Stripe |
| Operations / kiosk | **partial / disabled** | `src/lib/kiosk/adapter.ts` — `getKioskAdapter()` **always** returns `NullKioskAdapter` (dispense → `unsupported`); `KIOSK_ADAPTER` env documented in `.env.example` but **never read in `src/`**; ingest endpoints (`api/kiosks/{manifest,playback,creative}`, `api/devices/events`) need `KIOSK_INGEST_SECRET` (absent locally) | Physical hardware interface unknown; no real adapter exists | **P0 for ops** — fleet heartbeats/lifecycle exist but nothing can physically dispense; rental flow cannot complete end-to-end without it |
| AI — support assistant | **partial** | `src/lib/ai/{assistant,openrouter,account-tools,knowledge}.ts`, `api/support/assistant` (503 `assistantConfigured()` false without `OPENROUTER_API_KEY`) | `OPENROUTER_API_KEY` absent locally | Medium — honest degradation, but unverified against a real model (`LAUNCH-READINESS` item 6b says eval pass still needed) |
| AI — account tools | **implemented-unverified** | `ACCOUNT_TOOLS` in `account-tools.ts`: read own rentals/payments/tickets/partner info + write own tickets/messages/escalations; actor-scoped, service client explicit | Same OpenRouter dependency | Medium — write tools (ticket create/reply) execute real mutations; covered by `ai-account-tools.test.ts` |
| AI — agent registry | **implemented-unverified** | `src/lib/agents/registry.ts` — 13 seed agents, `canRun()` enforces enabled/hourly-cap/daily+monthly budgets (fail-closed), `DENIED_ACTIONS` (refund.issue, payout.modify, payment.adjust, …) can never be approved via `decideApproval`; payload sanitization + error scrubbing | Agents seeded lazily via admin page; no autonomous scheduler invokes `runAgent` outside admin/eval paths found | See §3.7 — autonomy levels are metadata, not enforced tiers |
| AI — evals | **implemented-unverified** | `src/lib/evals/runner.ts` (weighted scenario scoring), `api/admin/evals/**` (create/run, `mock:true` CI-safe) | Requires admin auth + OpenRouter for real runs | Low |
| AI — knowledge lifecycle | **implemented-unverified** | `src/lib/knowledge/{db,types}.ts` — draft→in_review→approved→published→archived, content edits knock back to draft, versioned, audience-scoped; complements static KB `lib/ai/knowledge.ts` | Admin curation needed to populate | Low |
| Communications — Brevo outbound | **implemented-unverified** | `lib/helpdesk/mailer.ts` + `email_outbox` queue, `lib/email/senders.ts` (11 department identities), `lib/email/routing.ts` trigger registry (**19 wired / 8 planned / 1 no_template**), `lib/email-templates.ts`, `email-studio` admin | `BREVO_API_KEY` present locally; Vercel/DNS verified per `docs/DEPLOYMENT.md` (SPF/DKIM/DMARC pass on real message) | Low |
| Communications — inbound email | **partial** | `api/webhooks/email/inbound` (Brevo inbound parse, `EMAIL_INBOUND_SECRET` header auth, 2MB/50-item caps, dedupe) → `inbound_jobs` → `lib/inbound/worker.ts` → `processor.ts` | **Only appends to existing tickets** — no new-ticket intake path (§3.6) | Medium — customers emailing support@ without a ticket ref are silently `ignored` |
| Communications — Twilio SMS | **implemented-unverified** | `src/lib/sms.ts` (REST send, STOP/START opt-outs `sms_opt_outs`, transactional vs nudge kinds), `api/webhooks/twilio`, `notification_jobs` engine (0013), phone OTP | `TWILIO_*` absent locally | Medium — OTP + reminders undelivered until creds set |
| Financial — Stripe checkout/webhook | **blocked** | `lib/stripe.ts` (manual-capture holds, off-session PIs, `verifyStripeSignature` HMAC+timestamp), `api/webhooks/stripe` (dedupe via `stripe_events` PK, retries on handler failure, routes rental/ad/monetization kinds), `lib/monetization/webhook.ts` | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | **P0** |
| Financial — settlement/ledger/refunds | **implemented-unverified (with a real gap)** | `api/rentals/[id]` capture/release/non-return fee + credit settlement; `billing_ledger` (0016); admin refund `api/admin/payments/[id]/refund` uses `stripe.createRefund` directly | **Helpdesk `issueRefund` uses `getRefundProvider()` which is permanently `NotConfiguredRefundProvider`** (`lib/payments/source.ts:51-54`) — approved helpdesk refunds can never auto-issue even with Stripe keys; only the separate admin payments route issues | **P1** — two divergent refund paths; helpdesk-approved refunds silently defer to manual |
| Security — RLS/rate-limit/session | **implemented-unverified** | RLS on every table (0001–0037), staff-read-only/service-write split (0006), `profiles_block_privilege_change` (0005), `lib/rate-limit.ts`, card-number guard + honeypot in `lib/submit.ts`, 24h absolute session cap | Live Supabase exercise pending | Low |
| Observability | **implemented-unverified** | `lib/observability.ts` (`recordLog`/`recordSpan`/`reportError`/`newTraceId` → app_logs/trace_spans/error_events), `lib/fleet-sweep.ts` (offline stations, low battery, command expiry), `api/cron/{rentals,inbound,uptime,analytics}` + `vercel.json` (all **daily** — Hobby plan limit), `ALERT_WEBHOOK_URL` optional | Cron is daily-only; `HELPDESK_DEV_STORE` unset → routes return honest 503/empty without Supabase | Medium — daily crons mean non-return fees/reminders run once/day |

---

## 3. Known gaps — verified findings

### 3.1 Stripe credentials — ABSENT locally, Vercel unknown
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are not in `.env.local`. Every payment surface (`api/rentals/checkout`, `api/rentals/[id]`, `api/monetization/*/checkout`, `api/gifts`, `api/advertiser/campaigns/[id]/checkout`, `api/events/passes/[id]/checkout`, `api/groups/[id]/fund`, `api/admin/payments/[id]/refund`, `api/webhooks/stripe`) returns honest 503s without them. **No revenue is possible in this environment.** Vercel env state cannot be verified from the repo — commit `07685e4` shows env vars are added via redeploy, so presence on Vercel is plausible but unconfirmed.

### 3.2 `GIFT_SALES_ENABLED` — unset (default off, by design)
`src/lib/gifts.ts:53`. Gift purchases are closed until staff flip it on; `GIFT_PACKAGES` prices ($10/$25/$50) are explicitly unapproved seed values pending owner review.

### 3.3 Membership plan seed data — MISSING
No migration or seed script inserts into `membership_plans`; only `src/app/api/admin/monetization/plans/[id]/route.ts` and `api/admin/advertising/route.ts:121` write rows. Until an admin creates plans, `/account/charging` and `api/monetization/plans` return an empty catalog. **Flag: monetization stage 2 shipped the engine but not the catalog.**

### 3.4 Login `?next=` — NOT honored (confirmed bug)
`ClaimClient.tsx:46` sends gift claimants to `/login?next=/account/gifts/claim?t=…`, but nothing reads `next`: `login/page.tsx` only destructures `error`; `LoginForm.tsx` `submit()` always calls `router.push(homeFor(data.role))`; `api/auth/{login,email-link,phone,callback}` routes contain no `next` param handling. **After sign-in the user lands on their home page and the one-time claim context is lost** (recoverable only by re-opening the emailed link). Same issue affects any future deep-link-to-login flow.

### 3.5 Gift claim bearer-token vs email-binding — bearer token confirmed
`api/gifts/claim/route.ts` requires only a valid session + token hash match (`claim_gift(p_token_hash, p_profile)`); it never compares the claimant's email to `recipient_email`. Any signed-in account holding the link can claim within 72h. Mitigations present: 24-byte random token, sha256-only storage, 72h expiry, 10-attempt/10-min IP+token rate limit (`claim/route.ts:39`), atomic single-claim RPC. **Policy decision to confirm with owner**: intended ("forward the gift") vs should bind to `recipient_email`.

### 3.6 Inbound email routing coverage — replies only, no new tickets
`src/lib/inbound/processor.ts` accepts mail only when it (a) carries a valid `+token` reply address for an existing ticket, or (b) references `Z-<n>` in subject/body AND sender matches. Everything else → `ignored: no_ticket_reference`. Consequence: `support@`, `billing@`, `partners@`, `legal@`, `security@` etc. all resolve through Brevo inbound parse to the same webhook, but **a fresh email to any address creates nothing** — no ticket, no queue item beyond `inbound_emails` log. New-customer email intake is effectively missing; only ticket replies work.

### 3.7 AI autonomy levels — registry metadata vs enforcement
`agents/registry.ts` enforces: `enabled` flag, hourly call cap, daily/monthly cost budgets (fail-closed on telemetry errors), approval workflow with sanitized payloads and a `DENIED_ACTIONS` denylist. It does **not** enforce per-permission tiers: `permissions[]` and `escalation_policy` are stored metadata — nothing in `canRun`/`runAgent` checks them against tool access. Actual blast radius is bounded indirectly because the only wired tool surface is `ACCOUNT_TOOLS` (actor-scoped reads + own-ticket writes) and `DENIED_ACTIONS` blocks money/admin actions at approval time. **Honest status: autonomy is "budget + approval-gate" enforced, "permission/escalation" declared-only.**

### 3.8 Physical kiosk — disabled by design
`src/lib/kiosk/adapter.ts:45` — `getKioskAdapter()` unconditionally returns `IdempotentKioskAdapter(NullKioskAdapter)`; `dispense()` → `{status:"failed", reason:"unsupported"}`. `KIOSK_ADAPTER` env var exists in `.env.example`/`.env.local` but is **never referenced in `src/`** — there is no adapter-selection code. Kiosk ingest endpoints (`manifest`, `playback`, `creative`, `devices/events`) are live and secret-gated (`KIOSK_INGEST_SECRET`, absent locally). Heartbeat/lifecycle/command tables exist (0015) and `fleet-sweep` monitors them, but no station can report in without the secret and no bank can dispense without a hardware adapter.

### 3.9 Email DNS / BIMI / DMARC — partially verified per docs
`docs/DEPLOYMENT.md:155-164`: BIMI record exists for `default._bimi.zapnivo.com` with logo assertion only (**no `a=` certificate** — CMC/VMC cert still required; Zapnivo has no registered trademark). DMARC is `p=none` — BIMI won't render and enforcement is explicitly deferred until Google Workspace outbound DKIM signing is confirmed. Real-message audit (2026-11-10) showed SPF/DKIM/DMARC **pass** for Brevo transactional `@zapnivo.com` senders. SPF covers Google Workspace only; Brevo uses its own envelope domain so DMARC alignment rides on DKIM. `public/bimi/zapnivo.svg` exists.

### 3.10 Other verified stubs
- `src/lib/payments/source.ts`: `PaymentSource` and `RefundProvider` are permanent stubs (`NotConfigured*`) — the "link Stripe later" seam was superseded by `lib/stripe.ts` but `getRefundProvider()` still feeds helpdesk `issueRefund`, so **helpdesk-approved refunds always return deferred/manual even when Stripe is configured**. Admin refund issuance works only via the separate `api/admin/payments/[id]/refund` route.
- `src/lib/groups.ts` header comment claims staff-only funding — stale; self-serve funding shipped in phase 3.
- `docs/LAUNCH-READINESS.md` is the **initial-build** report; many "READY-TO-INTEGRATE/BLOCKED" rows (auth, portal, Stripe seam, kiosk adapter, analytics provider) have since shipped. Treat as historical, not current.
- Vercel crons are all **daily** (`vercel.json`); Hobby plan limit noted in `DEPLOYMENT.md`. Inbound worker compensates via post-response `after()` kick.
- Migration numbering skips `0018` (0001–0037 present = 36 files).

---

## 4. Prior-stage reconciliation

| Stage (per commit history / docs) | Claimed | Actually found |
|---|---|---|
| Initial build (LAUNCH-READINESS items 1–20) | Mostly DONE/READY-TO-INTEGRATE | Website, SEO, schema, tests, legal drafts genuinely done. Items marked READY-TO-INTEGRATE (auth, portal, payments, kiosk, email) have since been built out — doc is stale but was honest at time of writing. |
| Customer portal + phone sign-in (036ec917) | Phone OTP + rentals on `/account` | Implemented; OTP delivery unverified (no Twilio creds locally). |
| First-party analytics + 24h session cap + admin dashboard (032b8c0) | Analytics pipeline, GA4 hook, session cap | `analytics_daily`/`analytics_cohorts` (0030), `lib/analytics*.ts`, `trackServer`, session registry — implemented-unverified live. |
| Intelligence platform stages 2–5 (9b84a51) | Session security, AI tools, agents, knowledge, experiments, evals | All present in code + migration 0029; agent registry enforces budgets/approvals but permission tiers are metadata (§3.7). |
| Advertising marketplace + sponsored charging (058de75) | Ads core + sponsored charging | Migration 0027 + checkout/settlement integration present; Stripe-gated. |
| Observability platform (f7fdb38) + hardening (f8000b1) | Error/uptime/cron monitoring, debug assistant | `lib/observability.ts`, cron routes, admin/observability — implemented; daily-cron cadence limits freshness. |
| Monetization stage 2 (ec2cf4b) | Memberships, gift credits, prepaid packages, groups, events | Engine complete; **membership catalog empty (no seed)**, gift sales gated off, all purchases Stripe-gated. |
| Monetization phase 3 (d551e94, HEAD) | Atomic redemption, credit settlement, gift delivery, group funding | RPCs 0034–0037 + `credits.ts` + `gifts-delivery.ts` + group fund route all present and unit-tested; live-DB/Stripe verification pending. |

**Marked-done-but-partial flags:** (a) helpdesk refund issuance — approval workflow done, provider issuance stubbed; (b) kiosk lifecycle/heartbeat — monitoring done, physical control absent by design; (c) inbound email — pipeline done, intake scope is replies-only; (d) agent "permissions" — stored, not enforced.

---

## 5. Prioritized remediation backlog

### P0 — blocks revenue or core trust

1. **Provision Stripe env vars** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, optionally `STRIPE_TAX_ENABLED`) in Vercel; register webhook endpoint `/api/webhooks/stripe`; run a test-mode rental end-to-end.
   - *Acceptance:* checkout session created, webhook verifies signature, `payments` row reaches `captured`/`released`, `billing_ledger` + receipt email fire; `stripe_events` dedupe confirmed on replay.
2. **Decide kiosk strategy.** Either implement a real `KioskAdapter` (needs manufacturer docs/unit) or formally descope physical dispensing and re-scope the rental UX (QR/manual handoff). `KIOSK_ADAPTER` env is dead code until selection logic exists.
   - *Acceptance:* `getKioskAdapter()` selects adapter by env; a dispense path either works against hardware/simulator or the product flow is explicitly manual with honest UI.
3. **Set `KIOSK_INGEST_SECRET` (and confirm on Vercel)** so station ingest endpoints function; verify `devices/events` heartbeat writes `kiosks.last_seen_at`.
   - *Acceptance:* a signed heartbeat updates station state; unsigned → 401.

### P1 — trust/correctness gaps

4. **Fix `?next=` deep-link handling** in `/login` (all auth methods: password, email-link, phone, Google OAuth `next` param, callback). Sanitize to same-origin paths only.
   - *Acceptance:* `/login?next=/account/gifts/claim?t=…` returns the user to the exact claim URL after any sign-in method; open-redirect attempts rejected.
5. **Reconcile refund paths.** Either wire `getRefundProvider()` to `stripe.createRefund` (idempotency key = refund id, matching `api/admin/payments/[id]/refund`) or remove the dead seam and route helpdesk `issueRefund` through the working admin path.
   - *Acceptance:* an approved helpdesk refund issues via Stripe exactly once (idempotent), status `issued` with `provider_refund_id`; failure → `failed` with retry.
6. **Decide gift-claim binding policy.** If bearer-token is intended, document it; if not, bind `claim_gift` to `recipient_email` (or verified email) in the RPC.
   - *Acceptance:* documented decision; if binding chosen, wrong-account claim returns a clear error and token remains unconsumed.
7. **Seed membership plans** (owner-approved prices) via migration or admin UI runbook; verify benefit→entitlement grant mapping for each plan.
   - *Acceptance:* `/account/charging` lists ≥1 active plan; purchase→webhook→`customer_memberships` + entitlement grant verified in staging.
8. **Provision Twilio + OpenRouter creds** (or formally disable SMS/OTP and AI surfaces with honest UI — OTP already degrades gracefully).
   - *Acceptance:* OTP SMS delivers; assistant answers a scripted prompt via `OPENROUTER_MODEL`; run `api/admin/evals/[id]/run` once against the real model and record the score.
9. **Inbound email: decide new-ticket intake.** Either add a "new ticket from unmatched sender" path (with sender-verification/DMARC rules) or document that email intake is reply-only and surface that in support UI.
   - *Acceptance:* decision recorded; if built, an email to `support@zapnivo.com` creates a `Z-####` ticket exactly once (dedupe-verified).

### P2 — hardening / completeness

10. **Enforce or remove agent permission metadata** — either check `permissions[]` inside tool dispatch or relabel registry fields as informational.
11. **Raise cron cadence** (upgrade plan or add external scheduler) so rental sweeps/non-return fees run more than daily; document the chosen cadence in `DEPLOYMENT.md`.
12. **BIMI/DMARC progression** — enable Google Workspace outbound DKIM, move DMARC `p=none`→`quarantine`→`reject`, obtain CMC cert, add `a=` tag. Tracked in `DEPLOYMENT.md:155-164`.
13. **Refresh `docs/LAUNCH-READINESS.md`** or supersede with this audit series so future agents don't reconcile against stale statuses; fix stale comments (`groups.ts` funding, `payments/source.ts` "link later" notes).
14. **Live-DB verification pass** for migration 0031–0037 RPCs (entitlement reserve/commit/release edge cases, `claim_gift`, `issue_event_pass`) against a real Supabase project — unit tests use fakes.
15. **Vercel env audit** — produce a definitive list of which of the 20+ env vars are actually set in production (cannot be verified from repo).
