# E2E tests (Playwright)

Run: `npm run e2e` (debug UI: `npm run e2e:ui`).

## Safety

`playwright.config.ts` starts the app itself with every backend credential forced to an
empty string (process env beats `.env.local`), so Supabase/Stripe/mail are "unconfigured"
and no test can write a real row. Public forms are expected to answer an honest 503 and the
suite asserts that — it never asserts a fake success.

- Main server (port 3100): `next build && next start` into `.next-e2e` (set `E2E_DEV=1` to
  fall back to `next dev` when the tree does not build; `e2e/global-setup.ts` warms every
  route once because dev compiles lazily).
- Dev-store server (port 3101, `next dev` + `HELPDESK_DEV_STORE=1`, `.next-e2e-dev`):
  only for `devstore.spec.ts` (synthetic admin/partner, JSON store in `.data/` — delete it
  after local runs if created).
- `E2E_REUSE=1` reuses already-running servers.

## Coverage

| Spec | What it checks |
|---|---|
| `public-routes` | Every sitemap URL + /support, /support/new, /login: 200, exactly one h1, unique non-empty title & meta description, self-referencing canonical, no noindex (except intentional: /login, /support/new). Sitemap contents, legal page rendering, 404s. |
| `security` | CSP/XFO/HSTS/nosniff/Referrer-Policy; portal pages (/admin, /partners) gated — redirect to /login when auth is configured, honest "not configured" notice otherwise; admin API routes 403 unauthenticated; /api/devices/events 503 without KIOSK_INGEST_SECRET; /api/dev/as is 404 outside `next dev`. |
| `subdomains` | Host-header routing for support/internal/partners/api .localhost (proxy rewrites, redirects, noindex), api.* service document, per-host robots.txt (internal/partners/api disallow all). |
| `forms` | Contact, partner application (3-step), support ticket: native constraint validation on empty/invalid input (no request fires), valid submit → HTTP 503 + `role=alert` error, never a success state. |
| `mobile` | 390x844: no horizontal overflow on /, /how-it-works, /business, /locations, /support, /login; mobile menu opens/Escape closes/navigates; toggle has an accessible name and a visible focus indicator. |
| `a11y` | Every public page: images have `alt`, svg[role=img] is named, form controls have labels; axe WCAG 2.x scan (below). |
| `devstore` | HELPDESK_DEV_STORE synthetic users: all admin/partner pages render (status 200, h1, no error boundary), role switcher cookie + back= allowlist, partner cannot open admin pages. |

## axe violations (pre-existing, recorded not failed)

Non-blocking (serious impact; test fails only on critical). Report JSON:
`test-results/axe-<project>.json`.

- `color-contrast` (serious) — /how-it-works (3), /business/apply (4), /about (3),
  /support (7), /support/new (1). Mostly muted `silver`/`graphite` text on light
  backgrounds in footers/badges.
- `definition-list` (serious) — /support (1), a `<dl>` without proper dt/dd structure.
