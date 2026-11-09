# Zapnivo — website & platform

Portable phone-charger rental network launching in Minnesota.
**Life moves. Power follows.**

Next.js 16 + TypeScript + Tailwind v4, Supabase (Postgres + Auth + Storage), designed for Stripe.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck  # tsc --noEmit
npm run test       # vitest
npm run build      # production build
```

No env vars are needed to preview the public site. Forms return a clear "not configured" 503
(never a fake success) until Supabase is connected — see `.env.example`.

## Wire up the backend

1. Create a Supabase project.
2. Apply `supabase/migrations/` in order: `0001_init.sql` (tables, RLS, buckets, `pilot-2026-v1` pricing), `0002_support_lookup.sql` (rental references `ZR-XXXXXXXX`), `0003_payment_refund_totals.sql` (refund totals for Stripe linking), `0004_helpdesk.sql` (threads, messages, SLA, audit events, refunds, partner requests), `0005_security_lockdown.sql` + `0006_service_writes_only.sql` (RLS hardening — JWTs are read-only; all writes via the service layer).
3. Copy `.env.example` → `.env.local` and fill in the three Supabase keys.
4. Partner/support/contact/advertising forms now persist rows; `/login` authenticates
   against `profiles.role` for `/admin` and `/partners`.

## Structure

```
src/app/            routes (public site, /admin, /partners, /api/*)
src/components/     header, footer, forms, story, showcase, illustrations
src/lib/            pricing, validation (zod), submit pipeline, rate limit,
                    supabase clients, auth, kiosk adapter, analytics
supabase/migrations database schema + RLS
tests/              vitest unit tests
docs/               security checklist, launch-readiness report
legacy/             original single-page concept
```

## Design notes

- Palette: `#F7F8F4` paper, `#161A18` ink, `#C7F43C` lime, `#E8EBE6` mist, `#253128` forest.
- Type: Space Grotesk (display) + Manrope (body), local via next/font.
- All imagery is original SVG, labeled "Illustrative render". Drop real photography into
  `public/images/` and swap the illustration components for `<Image>` when available.
- Reduced-motion is respected; content is visible with JS disabled.

## Honesty rules baked in

- No live stations are shown until real rows exist (`venues.published`).
- Pilot pricing is labeled proposed; `pricing_versions.approved=false` → never charged.
- No revenue-share terms appear on public pages — agreements live in private tables only.
- The kiosk adapter fails safe: `NullKioskAdapter` can never report a successful dispense.

## AI support assistant

`/support` has an "Ask Zapnivo AI" chat (OpenRouter). It is *grounded*, not fine-tuned: every request is built from `src/lib/pricing.ts`, `src/lib/support-content.ts` and the live station list (`src/lib/ai/knowledge.ts`), so editing those updates the assistant.

- Set `OPENROUTER_API_KEY` (and optionally `OPENROUTER_MODEL`, must support tool calling).
- Transactions: the assistant calls the same `lookupRentals` service as the lookup form.
- Linking Stripe later: see the header of `src/lib/payments/source.ts`; apply migration `0003_payment_refund_totals.sql`.

## Support helpdesk (operations)

Support is a real ticket system, not a form. Customer and partner messages create threaded tickets (`Z-####`) that are triaged (AI when configured, deterministic rules always), routed to a queue (customer / billing / partner / safety), SLA-timed, and answered by staff — every action is audit-logged.

- **Customer side:** `/support` → ticket form, "Track a ticket" (number + email → signed 7-day link), thread page `/support/ticket/Z-####?t=…` with replies, "talk to a person", and resolve.
- **Staff side:** `/admin/support` inbox → ticket workspace `/admin/support/Z-####` (replies, internal notes, assignment, state/priority, AI draft, refund requests) → `/admin/support/refunds` queue → `/admin/support/metrics` dashboard.
- **Partner side:** `/partners/support` — venue requests in a separate partner-relations queue, isolated by organization.
- **Refunds:** policy-checked (`src/lib/helpdesk/refund-policy.ts`) — max refundable computed from captured vs published rates, per-rental balance tracking, agents capped at the 24h cap / goodwill at the first-hour price, above that needs a *different* admin. Issuing goes through the `PaymentSource` seam: without Stripe it returns `deferred` and is recorded manually; nothing is ever auto-refunded by the AI.
- **Email:** all notifications go through an outbox (`src/lib/helpdesk/mailer.ts`). Without `RESEND_API_KEY` they stay queued — nothing claims to be sent.
- **Secrets:** set `HELPDESK_SECRET` (32+ bytes) in production to sign customer conversation links. Without it, prod issues no links — customers re-verify with number + email each visit.

### Try it locally with zero setup

```
HELPDESK_DEV_STORE=1 npm run dev
```

This enables a JSON-file store (`.data/helpdesk.json`), three **clearly labeled `DEMO` rentals** (`ZR-DEMO0001/2/3`), and a synthetic sign-in. A gold dev banner shows who you're acting as; switch roles at `/api/dev/as?role=admin|admin2|agent|partner`. Hard-disabled in production builds — `NODE_ENV=production` ignores the flag entirely. Never put real customer data in the dev store.
