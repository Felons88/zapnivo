# Production issue register — 2026-11-10

The live crawl evidence is in `production-crawl-2026-11-10.csv`. Severity is based on impact if the relevant workflow is enabled; several rental workflows are not yet launched.

| ID | Severity | Evidence and affected area | Resolution / verification |
| --- | --- | --- | --- |
| SEO-01 | P1, resolved before this audit | Reported apex 502. Live HTTPS apex now returns 308 to `https://www.zapnivo.com/`; both apex A records and www present valid TLS in prior checks. | Vercel domain assignment is valid; no code change. Recheck after release. |
| SEO-02 | P2, fixed locally | Customer host was using public robots rules and public sitemap despite serving a private account. `src/app/robots.ts`, `src/app/sitemap.ts`. | Disallow customer host and return an empty sitemap; e2e host test. |
| MAP-01 | P2, fixed locally | Map fallback exposed `NEXT_PUBLIC_MAPBOX_TOKEN` instructions to customers. `src/components/NetworkMap.tsx`, `Locator.tsx`. | Customer-safe loading/error/empty states; desktop/mobile production browser check found Mapbox style and tiles HTTP 200. Local fallback still needs postdeploy verification. |
| RENT-01 | P1, fixed locally | Required terms and optional SMS consent were checked in UI but omitted from checkout POST; API did not enforce terms. `RentForm.tsx`, checkout route. | Send both fields; reject false/missing terms; targeted tests. No live charge used. |
| PAY-01 | P1, partially fixed locally | Stripe webhook acknowledged Supabase reconciliation failures. `src/app/api/webhooks/stripe/route.ts`. | Failed writes now return 500 and retry if event-claim cleanup works; targeted test. Full outage may also prevent cleanup, requiring durable processing-state design. |
| AUTH-01 | P1, fixed locally | Auth callback origin was derived from untrusted request Host in email, phone, Google and callback routes. | Exact allowed host list and forged-Host tests; production build pending. |
| BIZ-01 | P2, fixed locally | Partner application required operating hours and placement detail although database columns are nullable; error navigation returned to first step. `forms.tsx`, `validation.ts`. | Optional fields and step-specific feedback; validation tests. Live insert deliberately not performed. |
| LEGAL-01 | P1, owner action | Rental terms claimed a 24-hour maximum and a proposed 72-hour return, contradicting `src/lib/pricing.ts`. All six legal pages remain drafts with `[REVIEW]`. | Conflicting assertions removed; owner/legal approval of actual rates, privacy and service terms still required. |
| HW-01 | P1, launch blocker | Physical kiosk adapter remains a fail-safe null implementation. | Integrate and verify hardware with authorized staging systems before enabling real rentals. |
| OPS-01 | P2, open | Live Stripe/Twilio delivery, Supabase migrations and secrets, Vercel logs, and hardware have not been verified end to end with authorized staging credentials. | Verify in staging; do not infer from mocked unit tests. |
| PERF-01 | P3, open | No measured Lighthouse or field Core Web Vitals report in this audit. | Run controlled Lighthouse and monitor Vercel Web Analytics after release. |

No production database migration is part of this repair. No live payment, SMS, hardware action, or partner lead was created during testing.
