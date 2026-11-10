# Deploying to Vercel

The app is a standard Next.js 16 project — Vercel auto-detects it. No `vercel.json` needed.

## 1. Push to GitHub

```bash
# create an empty repo at github.com/new (private recommended), then:
git remote add origin https://github.com/<you>/zapnivo.git
git push -u origin main
```

## 2. Import in Vercel

Dashboard → Add New → Import Git Repository → pick `zapnivo`. Framework: Next.js (auto). Root dir: `.`.

## 3. Environment variables (Production)

Copy values from local `.env.local`; **never commit them**.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://www.zapnivo.com` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://qidbieuvxeqtbqobjkns.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | from `.env.local` — **server-only** |
| `HELPDESK_SECRET` | from `.env.local` — required for customer thread links |
| `KIOSK_ADAPTER` | `none` |

Optional / later: `NEXT_PUBLIC_MAPBOX_TOKEN` (map), `OPENROUTER_API_KEY` (+`OPENROUTER_MODEL`), `RESEND_API_KEY` or `BREVO_API_KEY` + `SUPPORT_FROM_EMAIL` (email — Brevo wins if both set), `STRIPE_*` (payments: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are server-only; set `STRIPE_TAX_ENABLED=1` only once Stripe Tax is configured. Webhook endpoint: `/api/webhooks/stripe` with events `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`. Checkout refuses until a `pricing_versions` row has `approved = true`.)

**Do NOT set `HELPDESK_DEV_STORE`** — it's dev-only and ignored in production builds anyway.

## 4. Domains & subdomains

The site is one Next.js app serving several hosts. `src/proxy.ts` routes by `Host`:

| Host | Serves | Notes |
|---|---|---|
| `zapnivo.com` / `www` | marketing site | `/support`, `/admin`, `/partners` 308 to their subdomain |
| `support.zapnivo.com` | `/support` | customer help center, tickets, assistant — apex-owned links bounce back to apex |
| `internal.zapnivo.com` | `/admin` | staff console, `X-Robots-Tag: noindex`, robots disallow-all |
| `partners.zapnivo.com` | `/partners` | venue portal, noindex |
| `customer.zapnivo.com` | `/account` | customer account portal (rentals, receipts, incidents), noindex |
| `api.zapnivo.com` | `/api` | `/x` rewrites to `/api/x`; `/` returns a small JSON status |

Vercel project → **Domains**: all six hostnames are assigned to the `zapnivo`
project (domain is on Vercel DNS, so records/certs are automatic). Sessions:
the login cookie is scoped `Domain=zapnivo.com`, so one sign-in works on every
subdomain; partners sign in at `partners.zapnivo.com/login`, staff at
`internal.zapnivo.com/login`, customers at `customer.zapnivo.com` (phone OTP,
email magic link, Google, or password). `/account` on the apex 308s to the
customer subdomain.

Local dev is unchanged: `localhost:3000/support` etc. work as paths, and
`*.localhost` subdomains (`support.localhost:3000`) mirror production routing.
`BASE_DOMAIN` overrides the apex if the domain ever changes.

## 5. Provider-side settings

- **Supabase Auth** → URL Configuration → Site URL: `https://zapnivo.com`. Redirect URL allowlist:
  - `https://zapnivo.com/api/auth/callback`
  - `https://www.zapnivo.com/api/auth/callback`
  - `https://internal.zapnivo.com/api/auth/callback`
  - `https://partners.zapnivo.com/api/auth/callback`
  - `https://customer.zapnivo.com/api/auth/callback` (phone-OTP + magic-link land here)
  - `https://support.zapnivo.com/api/auth/callback`
  - `https://*.zapnivo.com/api/auth/callback` (wildcard covers future subdomains)
  - `http://localhost:3000/api/auth/callback` (dev)
- **Google sign-in** (one-time, ~10 min):
  1. Google Cloud Console → APIs & Services → OAuth consent screen → External; fill in app name/support email; **Authorized domains**: `zapnivo.com` and `supabase.co`.
  2. Credentials → Create → OAuth client ID → Web application. **Authorized redirect URIs**: `https://qidbieuvxeqtbqobjkns.supabase.co/auth/v1/callback` (exact value shown in Supabase → Authentication → Providers → Google).
  3. Supabase → Authentication → Providers → Google → enable, paste client ID + secret.
  Flow: `/api/auth/google` → Supabase → Google consent → `/api/auth/callback` →
  shared `zapnivo_access` cookie → role-based portal redirect. The callback must
  stay on the host where sign-in started (PKCE verifier cookie is host-bound).
- **Mapbox token** → restrict to `https://*.zapnivo.com` and `https://*.vercel.app` (previews).

## 6. Post-deploy smoke test

1. `curl -I https://zapnivo.com` → 200, has `Content-Security-Policy` header.
2. `https://zapnivo.com/api/dev/as?role=admin` → **404** (dev seams must be dead).
3. `https://support.zapnivo.com` → help center; create a test ticket → persists (Supabase), returns `Z-####` + signed `support.zapnivo.com/ticket/…` link.
4. `https://internal.zapnivo.com` → `/login` → sign in as admin → `/support` inbox shows the ticket.
5. `https://zapnivo.com/support` → 308 to `https://support.zapnivo.com/`; same for `/admin` → internal, `/partners` → partners.
6. `https://api.zapnivo.com/` → `{"service":"zapnivo-api","ok":true}`; `/robots.txt` on internal/partners/api → `Disallow: /`.
7. Rental lookup + AI chat show honest "not configured" until their keys are set — that's correct, not a bug.

## Notes

- Rate limiting is in-memory per instance — fine at Vercel scale for launch; move to Upstash Redis if abuse appears (`src/lib/rate-limit.ts` is the seam).
- `email_outbox` delivers nothing until `RESEND_API_KEY` or `BREVO_API_KEY` is set; staff can flush it from the metrics page.
- Preview deployments get the same env vars — that's fine (same Supabase project) unless you want a separate preview DB.
