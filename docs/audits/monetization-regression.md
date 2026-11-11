# Monetization regression audit

Read-only audit of every paid workflow: entry point → service → DB → Stripe →
webhook → entitlement effect → notification → error/recovery → tests →
production readiness. All paths relative to repo root. Citations are
`file:line`.

Verdicts: **operational** = chain connected end-to-end; **partial** = works but
with material gaps; **blocked** = cannot complete or money/entitlement diverges.

## Scorecard

| # | Workflow | Verdict | Biggest gap |
|---|----------|---------|-------------|
| 1 | Gift purchase → claim → cent credits → rental credit | **partial** | Gated off (`GIFT_SALES_ENABLED`); "refund" route never refunds money; code-claim and link-claim race is handled but dual-channel confusion remains |
| 2 | Membership purchase → period grants → benefits | **partial** | One-time repurchase race can double-charge/double-grant; no refund path; renewal relies solely on `customer.subscription.updated` |
| 3 | Package purchase → fulfillPackage → grants | **partial** | Grant-then-flip ordering can double-grant on webhook retry/crash; no refund/revocation path at all |
| 4 | Group funding → fund_group_credit → pool | **partial** | Pool is write-only: `credit_cents` is never debited at member checkout — funded money buys nothing spendable |
| 5 | Event pass → issuePass → checkout → redeemPass | **partial** | No purchase confirmation/receipt email; pass price can change between issue and checkout |
| 6 | Rental credits reserve → settle → release | **partial** | Abandoned `authorized` rentals leak reservations forever; `returned`+failed-capture rentals are not swept; credits commit before capture succeeds |
| 7 | Refunds (admin payment, gift, group, dispute) | **blocked** | Gift/group "refunds" issue no Stripe refund; package/membership/event-pass refunds unhandled; disputes & `charge.refunded` on monetization PIs silently dropped |
| 8 | Stripe webhook | **partial** | Signature + dedup solid; monetization PIs invisible to dispute/refund reconciliation; untested handler seams |

---

## 1. Gift purchase → claim → credits

**Chain (verified):**
- `POST /api/gifts` (`src/app/api/gifts/route.ts:68`) — auth + sameOrigin + rate limit + `giftSalesEnabled()` gate (`src/lib/gifts.ts:53`, env `GIFT_SALES_ENABLED`, **default off** → sales blocked in prod unless env set). Creates `gift_credits` row `pending_payment` with sha256 `code_hash` only (`route.ts:91-101`), returns raw code once.
- `createGiftCheckout` (`src/lib/monetization/checkout.ts:52`) — metadata `kind:"gift_credit", gift_id`.
- Webhook `checkout.session.completed` → `fulfillGift` (`src/lib/monetization/webhook.ts:126`): guarded `pending_payment → paid` flip (`:133-137`) — idempotent.
- Delivery: `deliverGiftClaim` (`webhook.ts:112`) mints 72h claim token for `recipient_email` gifts, stores only sha256 (`gifts-delivery.ts:18-25`), emails link via `giftClaimLink`. Best-effort, never fails fulfillment.
- Claim: `POST /api/gifts/claim` (`src/app/api/gifts/claim/route.ts:30`) → `claim_gift` RPC (`supabase/migrations/0034_atomic_ops.sql:158`) — atomic hash/expiry/status check + redeem + `cent` grant in one tx.
- Alternate path: code redeem `POST /api/gifts/redeem` (`src/app/api/gifts/redeem/route.ts:28`) — conditional `paid→redeemed` flip (`:69-72`), `grant()` unit `cent`, rollback on grant failure (`:91-98`). Attempt counter + generic errors.
- Credit consumption: `reserveForRental`/`applyCreditsAtSettlement` (`src/lib/monetization/credits.ts:43,86`) — see workflow 6.
- Notifications: `giftPurchaseConfirmation`, `giftClaimLink`, `giftRedeemedConfirmation` (`src/lib/email-gifts.ts`) — all fire-and-forget.

**Findings:**
- **Sales gated off by default** (`gifts.ts:53`) — intentional, but means the whole chain is untested in production until env flip.
- **"Refund" doesn't refund money.** `POST /api/admin/gifts/[id]/refund` (`src/app/api/admin/gifts/[id]/refund/route.ts:13`) flips status to `refunded` and revokes grants but **never calls Stripe** — no `createRefund` import. Staff must refund in the Stripe dashboard separately, and if they do, `charge.refunded` won't match (see workflow 7/8). Two-step manual process with no linkage.
- Dual redemption channels (shareable code + emailed claim link) both valid until first use — second claimant gets a generic error; acceptable but worth noting for support.
- `pending_payment` gift rows abandoned at checkout are never swept (no expiry job for `pending_payment`; `expires_at` is 365d and only checked at redeem).
- Tests: `tests/gift-delivery.test.ts` (fulfill idempotency, claim RPC mapping, sales gate), `tests/gifts.test.ts` — good coverage of the happy + replay paths.

## 2. Membership purchase → grants → benefits

**Chain:**
- `POST /api/monetization/membership/checkout` (`src/app/api/monetization/membership/checkout/route.ts:20`) — plan re-read server-side, price from `membership_plans` row; `interval==='one_time'` → `createMembershipCheckout`, else `createSubscriptionCheckout` (`checkout.ts:17,31`). No local row created — webhook is authoritative.
- Webhook `checkout.session.completed` → `activateOneTimeMembership` (`webhook.ts:38`) or `activateSubscription` (`webhook.ts:61`).
- One-time: dedupe on existing active/trialing membership same plan (`:45-47`), insert `customer_memberships`, `grant()` benefit via `benefitToGrant` (`:20-27` — rentals/minutes/credit_cents), `sendMembershipActivated`.
- Subscription: upsert by `stripe_subscription_id`, `grantPeriodBenefits` once-per-period via `last_granted_period_end` guard (`:91-98`).
- Lifecycle: `customer.subscription.created/updated` (`:216-239`), `.deleted` (`:240-253`), `invoice.payment_failed` (`:254-269`) — status map, period-end sync, cancel/payment-failed emails.
- Customer cancel: `POST /api/monetization/membership/cancel` (`route.ts:18`) — Stripe `cancel_at_period_end` for subs; local cancel for one-time; explicit "no refund" (`:60-61`).

**Findings:**
- **Double-purchase race (one-time):** `activateOneTimeMembership` checks-then-inserts with no unique constraint on `(profile_id, plan_id)` — two completed checkout sessions for the same plan can both pass the `existing` check and both grant. Customer pays twice, gets two memberships + double benefits.
- **Double-charge on repurchase while active:** nothing prevents buying the same one-time plan again; the webhook silently skips activation (`:47`) but the payment still clears — paid-but-nothing-happens.
- **No refund path** for memberships (one-time or subscription) — no admin route, no webhook refund handling.
- Renewal grants depend entirely on `customer.subscription.updated` firing each cycle with a new `current_period_end`; `invoice.payment_succeeded` is **not handled** — if Stripe ever skips the updated event, period benefits silently stop. Acceptable but fragile; consider handling `invoice.payment_succeeded` as the renewal trigger.
- `grantPeriodBenefits` compares `last_granted_period_end` to Stripe's period end with a 1s epsilon (`:94`) — safe against the checkout-computed-vs-Stripe skew in the common case, but a subscription whose period end moves *earlier* (e.g., plan change) could re-grant.
- Benefits are granted only after webhook — checkout success page may show `?paid=1` before benefits exist; no reconciliation UI.
- Tests: `tests/monetization-checkout.test.ts` covers route validation/checkout/cancel — **no tests** for `activateOneTimeMembership`, `activateSubscription`, or the subscription lifecycle handlers.

## 3. Package purchase → fulfillPackage → grants

**Chain:**
- `POST /api/monetization/package/checkout` (`src/app/api/monetization/package/checkout/route.ts:20`) — `package_purchases` row `pending` created **before** Stripe call (`:50-53`), amount snapshotted server-side, `kind:"package"` metadata.
- Webhook → `fulfillPackage` (`webhook.ts:142`): re-reads purchase + package (`active` check `:148-149`), `grant()` units (`:151`), then flips `pending→paid` (`:153`), `sendPackagePurchased`.

**Findings:**
- **Idempotency gap — grant before status flip.** `grant()` (`:151`) runs *before* the guarded `pending→paid` update (`:153`). If the update fails or the process dies between the two, a webhook replay sees `status='pending'` and **grants again** — duplicate entitlements for one payment. Compare `fulfillGift`/`fulfillGroupFunding` which flip first or use an atomic RPC. Fix: flip status first (guarded), then grant; or wrap in an RPC like `claim_gift`.
- **No refund/revocation path.** `package_purchases.status` allows `'refunded'` (`0031_monetization.sql:122`) but no route or webhook sets it, and nothing revokes the granted units. A Stripe-dashboard refund leaves entitlements live.
- Package `kind`/`units`/`validity_days` come from `prepaid_packages` at fulfillment time — admin edits between checkout and webhook change what was sold vs. granted (amount paid is fixed; units granted are not snapshotted on the purchase row).
- Tests: route covered in `monetization-checkout.test.ts`; **no test** for `fulfillPackage` grant/flip ordering.

## 4. Group funding → pool

**Chain:**
- `POST /api/groups/[id]/fund` (`src/app/api/groups/[id]/fund/route.ts:67`) — organizer-only (404 for others), $5–$500 bounds, `group_credit_purchases` `pending` row first (`:92-94`), `createGroupFundingCheckout` (`checkout.ts:80`, `kind:"group_funding"`).
- Webhook → `fulfillGroupFunding` (`webhook.ts:172`): re-reads purchase, `fund_group_credit` RPC (`0034_atomic_ops.sql:206`) atomically flips `pending→paid`, increments `rental_groups.credit_cents`, writes `entitlement_events` audit — returns false on replay (idempotent). `sendGroupFunded` email to organizer.
- Staff adjustment path: `adjustGroupCredit` (`src/lib/groups.ts:258`) → `adjust_group_credit` RPC (`0035_group_adjust_rpc.sql`) with negative-balance guard.
- Refund: `POST /api/admin/groups/funding/[id]/refund` (`route.ts:19`) — guarded flip + `adjust_group_credit` decrement with rollback on RPC failure (`:50-55`). **Explicitly issues no Stripe refund** (`:16-17`).

**Findings:**
- **The pool is a dead end for members.** `credit_cents` is only ever incremented/decremented/displayed — nothing at member rental checkout (`src/app/api/rentals/checkout/route.ts`) reads `rental_groups.credit_cents` or debits it. Groups header comment (`groups.ts:10-12`) still says "informational pool … self-serve funding is pending" — **stale**; funding is self-serve now, but consumption was never built. Organizer pays real money for a number on a page.
- Pending purchase rows abandoned at checkout are never swept.
- Refund route's flip-then-decrement with compensating restore is sound, but non-atomic across two writes — a crash between flip and RPC leaves `refunded` status with pool intact until staff retry (restore only runs on RPC *error*, not process death).
- Tests: `tests/group-funding.test.ts` — thorough (row-first ordering, webhook idempotency, refund no-double-fund). Good.

## 5. Event pass → checkout → redeem

**Chain:**
- Organizer `issuePass` (`src/lib/events-program.ts:238`) → `issue_event_pass` RPC (`0037_issue_pass_atomic.sql`) — advisory-locked cap + insert atomic; raw code shown once, sha256 stored.
- Buyer checkout: `POST /api/events/passes/[id]/checkout` (`route.ts:20`) — no auth required (bearer instrument), rate-limited, price resolved server-side via `passPriceCents` (`events-program.ts:283`) from `event_programs.price_cents` else attached package; `createEventPassCheckout` (`checkout.ts:94`, `kind:"event_pass"`).
- Webhook → `fulfillEventPass` (`webhook.ts:159`): `paid_at` stamp guarded by `.is("paid_at", null)` — idempotent.
- Redeem: `POST /api/events/passes/redeem` (`route.ts:24`) → `redeemPass` (`events-program.ts:335`) → `redeem_event_pass` RPC (`0034_atomic_ops.sql:114`) — single tx: unpaid/revoked/expired/window/cap checks, claim, `rental` unit grant, audit. Error map complete (`:307-318`).
- Grants consumed via normal rental credit flow (workflow 6).

**Findings:**
- **No purchase confirmation/receipt email.** `fulfillEventPass` only logs + stamps `paid_at` (`webhook.ts:159-164`). Buyer gets Stripe's receipt but no Zapnivo email confirming the pass/code — the code was shown to the *organizer* at issue time, and the buyer may never see it. Notification gap.
- `passPriceCents` rejects already-paid passes (`:287`) but allows **multiple concurrent checkouts** on the same unpaid pass — two buyers can both pay; webhook stamps `paid_at` once, second payment is orphaned money with no refund path.
- Price is resolved at checkout time, not snapshotted — organizer editing `price_cents`/`package_id` between checkout and webhook changes nothing retroactively (fine), but two buyers can pay different prices for the same pass.
- `stripe_checkout_session_id` overwrite at checkout (`route.ts:47`) is best-effort; webhook writes the completed session id anyway.
- Tests: `tests/event-pass-atomic.test.ts` (RPC contract), checkout/redeem routes lightly covered; **no test** for `fulfillEventPass` webhook handler.

## 6. Rental credits: reserve → settle → release

**Chain:**
- Checkout `POST /api/rentals/checkout` (`route.ts:102-111`): signed-in customer only (`customerId` requires session email match), `use_credits` default on; `reserveForRental` reserves cent (≤ hold), minute (covering hold), 1 rental unit via `reserve_entitlement` RPC (`0034_atomic_ops.sql:37`) — atomic, idempotent per rental+grant+amount.
- Settlement `captureOnReturn` (`src/app/api/rentals/[id]/route.ts:79`): computes gross → promo → sponsor discount → tax → `applyCreditsAtSettlement` (`credits.ts:86`) commits via `commit_entitlement`/`commit_entitlement_partial` (`0034:65`, `0036:2`), releases remainder via `release_rental_reservations` (`0034:97`); `creditApplied` reduces Stripe capture (`:128-141`), recorded on `payments.credit_cents` + ledger.
- Release paths: checkout rollback (`checkout/route.ts:116-123`), `payment_intent.payment_failed` → rental `cancelled` (webhook `route.ts:131-132`), settlement tail-release, cron `releaseOrphanedReservations` (`credits.ts:163`) via `/api/cron/rentals` (`route.ts:31-35`) for rentals in `cancelled|charged_off|refunded`.

**Findings:**
- **Abandoned checkouts leak reservations permanently.** A rental stuck in `authorized`/`dispense_pending` (customer never completes Stripe Checkout, or payment authorized but session abandoned) is *not* in `TERMINAL_STATES` (`credits.ts:156`) and there is **no expiry sweep for stale `authorized` rentals anywhere** — reserved credits stay locked indefinitely.
- **`returned` is not terminal.** If `capturePaymentIntent` fails after `applyCreditsAtSettlement` committed credits (`[id]/route.ts:139-140`), committed credits are consumed but the rental sits in `returned` — not swept, and the committed portion is gone even though no money was captured. Credits consumed + charge never collected.
- Commit-before-capture ordering: credits reduce `chargeTotal`, but if Stripe capture then fails, the credit discount is already committed — no compensating release/re-grant path.
- `applyCreditsAtSettlement` minute math (`credits.ts:111-116`) uses `Math.ceil` for minutes-needed then `minuteCents` for value — `applied` accounting (`:133`) approximates with `Math.min(p.cents, totalCents - applied)`; small rounding drift possible between credited cents and actual minutes consumed.
- `spendable` (`credits.ts:28`) doesn't filter expired grants server-side — relies on `status='active'`; expired-but-unswept grants could be reserved if cron lags (RPC does check `expires_at > now()`, so safe at reserve; display only).
- Guest rentals (`customerId=null`) skip credits entirely — by design.
- Tests: `tests/monetization-credits.test.ts` covers reserve/settle/release ordering well; **no test** for `releaseOrphanedReservations` sweep or the capture-failure-after-commit path.

## 7. Refunds

- **Admin rental payment refund** (`src/app/api/admin/payments/[id]/refund/route.ts:18`): admin-only, amount ≤ remaining captured, helpdesk second-person rule for large amounts, blocked by open refund request, `createRefund` → `refunds` row + `payments` state + negative ledger + audit. Solid. `charge.refunded` webhook (`route.ts:173-183`) reconciles `payments` rows.
- **Gift refund** (`api/admin/gifts/[id]/refund/route.ts`): revokes `gift_credit`-sourced grants + audit — **but issues no Stripe refund** (no Stripe import). Money movement is entirely manual/out-of-band; entitlement revocation is real.
- **Group funding refund** (`api/admin/groups/funding/[id]/refund/route.ts`): pool decrement via RPC, **no Stripe refund** (documented `:16-17`).
- **Package/membership/event-pass refunds: none exist.** No routes, no webhook handling.
- **Disputes:** `charge.dispute.*` (`route.ts:137-172`) looks up `payments` by `stripe_payment_intent_id` — only rental PIs live there. Disputes on gift/package/group-funding/membership/event-pass PIs hit `if (!pay) return true` (`:143`) — **silently marked handled, no dispute row, no staff alert**.
- **`charge.refunded` same blind spot** (`:175-182`): Stripe-dashboard refunds of monetization payments update nothing — entitlements stay live, purchase rows stay `paid`.

**Verdict: blocked** for monetization products; operational only for rental payments.

## 8. Stripe webhook

- Signature: `verifyStripeSignature` + 5-min window (`src/lib/stripe.ts`, tested in `tests/stripe-webhook.test.ts:8-27`). Route 503s without secret, 400s bad sig/payload (`route.ts:17-25`).
- Dedup: `stripe_events` insert-first; 23505 → 200 duplicate; handler failure → delete row + 500 so Stripe retries (`route.ts:32-51`). Sound.
- Routing: `handleMonetizationEvent` first (`route.ts:70`), then rental/ad/non-return-fee/dispute/refund branches.
- Handled `metadata.kind`: `membership`, `membership_subscription`, `gift_credit`, `package`, `event_pass`, `group_funding` (checkout.session.completed), `ad_campaign`, `non_return_fee` (PI events).
- Subscription lifecycle + `invoice.payment_failed` handled (workflow 2).

**Gaps:**
- `payment_intent.succeeded`/`payment_intent.payment_failed` for monetization kinds fall through to the rental `payments` update (`route.ts:108-113`, `:126-135`) — harmless no-ops since PIs aren't in `payments`, but means **failed membership/package/gift PIs leave purchase rows pending forever** with no dunning signal (checkout.session.completed simply never arrives).
- `invoice.payment_succeeded` not handled (see workflow 2).
- Disputes/refunds blind to all monetization PIs (workflow 7).
- `handleMonetizationEvent` returns `true` even when handlers no-op on missing metadata (`webhook.ts:213` default returns false only for unknown kinds — a `checkout.session.completed` with an *unknown* kind returns false → falls to rental branch → looks up `payments` by session id → no match → `return true`. OK but accidental).
- Untested seams: no webhook-route test exercises any monetization `kind` end-to-end through `handleEvent`; handler unit tests exist only for gift delivery and group funding.

---

## Prioritized fix list

1. **Group pool is unfunded value** — either build member-side debit of `rental_groups.credit_cents` at checkout/settlement, or stop selling funding until consumption exists. Highest revenue-integrity issue: real money for a display counter.
2. **Monetization refunds/disputes are invisible** — extend `charge.dispute.*` and `charge.refunded` to resolve gift/package/group-funding/membership/event-pass PIs (each row stores `stripe_payment_intent_id`/`stripe_checkout_session_id`), revoke entitlements on refund, alert staff on dispute. Add real `createRefund` calls (or explicit Stripe-dashboard instructions + linkage) to gift/group refund routes; add refund routes for package purchases and event passes.
3. **fulfillPackage grant-before-flip** — reorder to guarded status flip first, then grant (or single RPC); prevents double-grant on retry/crash (`webhook.ts:151-153`).
4. **Abandoned-checkout credit leak** — add expiry for stale `authorized`/`dispense_pending` rentals (cancel PI auth hold + release reservations) and include `returned`-with-uncaptured-payment in the orphan sweep; decide policy for credits committed before a failed capture (`credits.ts:156`, `[id]/route.ts:139-140`).
5. **Membership double-charge/double-grant** — unique constraint or atomic upsert on `(profile_id, plan_id, status active)`; block or refund repeat one-time purchases while active; handle `invoice.payment_succeeded` for renewal grants.
6. **Event pass gaps** — send purchase confirmation email in `fulfillEventPass`; prevent/flag multiple paid checkouts per pass (unique constraint on paid session or pass-level "checkout in progress" guard).
7. **Sweep pending commerce rows** — cron cleanup/flag for `pending_payment` gifts, `pending` package/group purchases, unpaid `event_passes`.
8. **Test the untested seams** — webhook route tests for each `metadata.kind`, subscription lifecycle handlers, `fulfillPackage`/`fulfillEventPass`/`activateSubscription`, orphan sweep, refund revocation paths.
