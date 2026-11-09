# Zapnivo website — agent notes

Next.js 16 (App Router, Turbopack) + TypeScript + Tailwind v4 + Supabase.

## Commands
- `npm run dev` — dev server (port 3000)
- `npm run typecheck` — tsc --noEmit (run before finishing work)
- `npm test` — vitest unit tests in `tests/`
- `npm run build` — production build

## Conventions
- Brand tokens live in `src/app/globals.css` `@theme` (paper/ink/lime/mist/forest/graphite/silver).
- Type classes: `.display-xl|lg|md`, `.eyebrow`, `.lead`, `.container-z`, `.grid-12`.
- Forms POST to `/api/*` via `handleSubmission` (zod + honeypot + rate limit + card-number guard).
  Success responses only after a real DB insert; 503 when Supabase isn't configured.
- Server-only code (service-role key, Stripe) must never be `NEXT_PUBLIC_` or imported by client components.
- Portal pages (`/admin`, `/partners`) use `PortalGate` + `export const dynamic = "force-dynamic"`.
- Subdomains (`src/proxy.ts` + `src/lib/subdomains.ts`): support→/support, internal→/admin,
  partners→/partners, api→/api. Apex paths 308 to the subdomain; `*.localhost` mirrors prod in dev.
  Portal links in emails go through `subUrl()` in `src/lib/site.ts` (path-based on non-apex hosts).
- Imagery is original SVG in `components/Illustrations.tsx`, labeled "Illustrative render" —
  replace with real photos in `public/images/` when supplied.
- Never fabricate: live stations, stats, partners, reviews, or revenue terms. Pricing comes from
  `src/lib/pricing.ts` / `pricing_versions` and stays `approved=false` until the owner finalizes it.

## Helpdesk
- All support operations go through `src/lib/helpdesk/service.ts` — it authorizes the actor AND
  writes an audit event. Never call the repo directly from a route.
- Customer thread access = signed token (`lib/helpdesk/access.ts`, `HELPDESK_SECRET`) or number+email.
  The dev fallback secret MUST stay a constant — a per-process random value breaks across dev bundles.
- Refund rules live in `lib/helpdesk/refund-policy.ts` (limits, second-person rule, balance tracking).
  The AI can never approve/issue refunds — only draft replies, and only where `triage.ts` allows.
- `HELPDESK_DEV_STORE=1` (dev only) = JSON store at `.data/helpdesk.json` + demo rentals +
  `/api/dev/as?role=` switcher. Routes/pages must handle `ctx === null` with an honest 503/empty state.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
