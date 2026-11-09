# Zapnivo — launch-readiness report

Generated for the initial build. Statuses: **DONE** (implemented & tested) · **READY-TO-INTEGRATE** (built, waiting on a service) · **BLOCKED** (needs third party / hardware / approval) · **APPROVAL** (needs owner sign-off).

| # | Deliverable | Status | Notes |
|---|-------------|--------|-------|
| 1 | Responsive public website | **DONE** | 16 routes: home, how-it-works, locations, business, apply, support, support/new, about, contact, advertise, 6 legal pages |
| 2 | Design system | **DONE** | Tokens in `globals.css` `@theme`; palette, type scale, 12-col grid, radii, buttons, badges, notices |
| 3 | Media library | **APPROVAL** | Original SVG renders, labeled illustrative. Awaiting real kiosk photo + lifestyle photography |
| 4 | Animation framework | **DONE** | CSS transitions + IntersectionObserver reveals; sticky scroll story; `prefers-reduced-motion` honored; content works with JS off |
| 5 | Venue partnership flow | **READY-TO-INTEGRATE** | 3-step validated form → `/api/partner-applications` → `partner_applications` table. Needs Supabase env vars; email notifications not yet configured |
| 6 | Customer support interface | **READY-TO-INTEGRATE** | Zendesk-style help center (renter + venue audiences, 30 articles generated from the pricing config, instant search), rental lookup (email + reference, or date/time/station), refund-review routing, ticket tracking, ticket form with photo upload → `support_tickets` (`Z-####`). Lookup/tracking return an honest 503 until Supabase + real rentals exist; the SQL query path is untested against a live DB |
| 6b | AI support assistant (OpenRouter) | **READY-TO-INTEGRATE** | Grounded in live pricing config + help articles (no fine-tuning needed; updates with the site). Tool-calling rental lookup through the same guarded service as the lookup form. Needs `OPENROUTER_API_KEY`; returns an honest 503 without it. Orchestration, guardrails and Stripe seam unit-tested with a scripted model; **not yet evaluated against a real model**: run a prompt-evaluation pass before launch |
| 6c | Stripe transaction linking | **BLOCKED (seam ready)** | `src/lib/payments/source.ts` `PaymentSource` interface + stub. Linking = implement `StripePaymentSource` + webhook; lookup and assistant pick up live captured/refunded amounts automatically |
| 7 | Admin dashboard | **READY-TO-INTEGRATE** | Role-gated shell (`admin`/`staff`) with fleet/rentals/partners/support/ads sections, honest empty states |
| 8 | Partner portal | **READY-TO-INTEGRATE** | Org-scoped pages; RLS isolates venues; private terms stay private |
| 9 | DB schema & migrations | **DONE** | `supabase/migrations/0001_init.sql` — 27 tables, RLS everywhere, buckets, seeded pricing |
| 10 | Role-based permissions | **DONE (design)** | RLS policies + server-side gate; needs a live Supabase project to exercise |
| 11 | Payment architecture | **READY-TO-INTEGRATE** | `pricing_versions` + server-side calc + idempotency design; Stripe keys pending. Nothing charges anyone |
| 12 | Kiosk adapter | **BLOCKED (by design)** | `KioskAdapter` interface + fail-safe null impl + idempotent wrapper. Real impl needs manufacturer docs/unit inspection |
| 13 | Legal pages | **APPROVAL** | All 6 present, clearly flagged as drafts needing attorney review |
| 14 | SEO | **DONE** | Metadata, canonicals, sitemap, robots, OG image route, JSON-LD, semantic headings |
| 15 | Analytics events | **DONE (defs)** | Event catalogue + consent-gated `track()`; provider choice pending |
| 16 | Automated tests | **DONE** | Vitest: pricing math, schema validation, card-number guard, rate limiter, idempotent dispense |
| 17 | Deployment config | **DONE** | Vercel-ready Next app; security headers in `next.config.ts` |
| 18 | Env documentation | **DONE** | `.env.example` + README setup steps |
| 19 | Security checklist | **DONE** | `docs/SECURITY.md` |
| 20 | This report | **DONE** | — |

## Blockers before public launch
1. **Owner approvals:** final daily pricing, pricing `approved=true`, legal review of policy drafts, founder/team content for About.
2. **Supabase project** + `.env` keys → forms persist, auth works.
3. **Real product photography** to replace illustrative renders.
4. **Stripe** test-mode integration for the rental checkout flow (Part 8) — currently absent, correctly.
5. **Hardware docs** for the kiosk adapter; QR-rental flow stays disabled until proven.
