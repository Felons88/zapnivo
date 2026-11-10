# Zapnivo email design system

Source of truth for branded transactional email. HTML lives in `email-templates/*.html`,
shared chrome in `email-templates/parts/`, plain-text fallbacks in `email-templates/text/`,
and `scripts/gen-email-templates.mjs` embeds everything into `src/lib/email-templates.ts`
(run `node scripts/gen-email-templates.mjs` after any change — never hand-edit the output).

Rendering: `renderEmail(name, vars)` returns a full HTML document with every `{{var}}`
HTML-escaped (XSS-safe; unknown vars are stripped). `renderEmailText(name, vars)` returns
the raw plain-text fallback. `EMAIL_TEMPLATE_NAMES` lists every registered template.

## How templates are built

- Each `.html` file is a complete document: `<head>` + preheader + 600px table shell.
- `{{>part_name}}` includes are resolved from `email-templates/parts/*.html` **at
  generation time** — the emitted strings are standalone HTML, so `renderEmail` needs
  no fs access and its signature is unchanged.
- Current shared parts: `masthead` (ZAPNIVO wordmark row) and `footer` (help strip +
  legal line, uses `{{year}}`). Hero variants, CTA buttons, and detail rows stay
  per-template because their accent colors and `{{var}}` contracts differ per email;
  a future layout wrapper could dedup them further.

## Brand tokens (email-specific)

Email intentionally differs from the site's `globals.css` tokens: emails must render
in clients with no CSS variables, so every value is inlined. The palette is the same
family but tuned for light-mode email clients.

| Token | Value | Use |
|---|---|---|
| page background | `#f1f4ed` | outer canvas |
| shell background | `#ffffff` | content card |
| footer background | `#f8faf6` | footer strip |
| hero background | `#151e18` | dark forest hero band |
| hero subtext | `#c7d2c8` | hero paragraph |
| hero divider | `#3a4a3c` + accent segment | 2px rule under hero copy |
| ink / body text | `#172018` | body color |
| strong text | `#152019` / `#142019` | detail values, totals |
| muted text | `#717a71`, `#647064`, `#7a8679`, `#8a9588` | labels, fine print |
| lime accent | `#c7f43c` | primary accent, success badges, primary CTA |
| lime-dark | `#719f0d` | "NIVO" wordmark half |
| lime badge bg | `#223419` | success status pill |
| amber accent | `#ffc978` | warning accent, action-needed badges/CTAs |
| amber badge bg | `#392b1e` | warning status pill |
| amber CTA text | `#513510` | text on amber button |
| red accent | `#ff8a5c` on `#3a1d16` | HIGH-severity ops alerts only |
| sage accent | `#e3ece1` on `#26342a` | neutral/info variant |
| sage CTA text | `#213222` | text on sage button |
| borders | `#e6ebe4` (rows), `#e6ece5` (footer) | hairlines |
| summary card | `#f0f5e8` bg, `#31402d` label | highlighted totals box |
| link green | `#406027` / `#556c51` | footer/support links |
| CTA primary text | `#1b2616` | text on lime button |

## Typography

- Stack: `Arial, Helvetica, sans-serif` everywhere (no webfonts in email).
- Wordmark: 25px / 900 / `#182319`, letter-spacing −1.6px; lime 10px square bullet.
- Tagline (masthead right): 10px / bold / `#778478` / letter-spacing 1.5px —
  hidden below 620px (`.brandright`).
- Eyebrow: 10px / 800 / letter-spacing 2.4px, accent-colored per variant.
- Status badge: 10px / bold, padded 9×11px, radius 7px, dark-tinted bg + accent text.
- H1 (`.bigtitle`): 47px / 800 / line-height 1.08 / letter-spacing −2px, white;
  36px on mobile.
- Hero sub: 15px / `#c7d2c8` / line-height 1.75, max-width 460px.
- Section label: 11px / 900 / letter-spacing 1.8px / `#6f796c`.
- Detail rows: 13px, label `#717a71`, value `#152019` bold, right-aligned,
  1px `#e6ebe4` bottom borders, 13px vertical padding.
- CTA: 13px / 800, padding 16×24px, radius 9px, `→` glyph, `&nbsp;` before arrow.
- Footer/legal: 11–13px muted; copyright line centered `#8a9588`.

## Layout & spacing

- 600px fixed shell (`max-width:600px`), outer padding `34px 16px 42px`.
- Masthead cell padding `0 3px 22px`; hero pad `35px 37px 32px`; content pad
  `34px 37px 35px`; footer pad `27px 37px 30px`; legal pad `23px 5px`.
- Hero top corners radius 16px; footer bottom corners 16px. Cards/buttons 9px,
  badges 7px, wordmark bullet 2px.
- Mobile breakpoint: `@media (max-width:620px)` shrinks `.outer` padding, `.content`
  padding, `.bigtitle` to 36px, hides `.brandright`, tightens `.footer`/`.heropad`.

## Audiences

- **Customer** — friendly tone, minimal rows, one primary CTA. Lime accent for
  positive/neutral, amber for action-needed.
- **Partner** — professional: statement cards (summary box), checklists, portal CTAs.
- **Admin/ops** — compact detail tables + severity badges; amber for warnings,
  `#ff8a5c`/`#3a1d16` red variant reserved for HIGH severity.

## Template inventory

| Template | Audience | Trigger (src/lib/email-extra-triggers.ts or email-triggers.ts) | Key vars |
|---|---|---|---|
| rental_started / returned / reminder | customer | `triggerRental*` (email-triggers.ts) | rental_id, venue_name, times, pricing_summary |
| nonreturn_notice | customer | `triggerNonreturnNotice` | rental_id, deadlines |
| payment_receipt | customer | `triggerPaymentReceipt` | receipt_id, amounts, receipt_url |
| payment_failed | customer | `triggerPaymentFailedHtml` (new; legacy `triggerPaymentFailed` still plain-text) | rental_id, venue_name, rental_url |
| refund_processed | customer | helpdesk service.ts | refund_amount, refund_id, … |
| support_created / support_updated | customer | helpdesk service.ts `notify()` | ticket_*, *_at |
| partner_inquiry | partner (ack) | `/api/partner-applications` route | business_*, contact_name, inquiry_id |
| partner_application_received | admin | `triggerPartnerApplicationReceived` | contact/business fields, submitted_at, admin_url |
| partner_approved | partner | `triggerPartnerApproved` | org_name, portal_url |
| revenue_statement | partner | `triggerRevenueStatement` | period, counts, all $ figures pre-formatted |
| station_offline | admin | `triggerStationOffline` | station fields, detected_at (HIGH) |
| payment_dispute | admin | `triggerPaymentDispute` | dispute fields, respond_by (ACTION REQUIRED) |
| security_alert | admin | `triggerSecurityAlert` | severity, alert_type, account/source refs, details |

## Rules

- Never fabricate stats, stations, partners, or revenue terms in copy.
- Pricing language: flat **$6.99 per started hour**, **no daily cap**,
  **$45 non-return fee after 24h** (see `PRICING_V1` in `src/lib/pricing.ts`).
  Templates take pre-formatted strings — never compute money in a template.
- All figures/URLs/dates arrive as `{{vars}}`; templates contain no logic.
- Keep the `{{>masthead}}`/`{{>footer}}` chrome consistent; add new shared parts
  under `email-templates/parts/` rather than copy-pasting blocks.
