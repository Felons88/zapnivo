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

## Email routing & inbound support replies

Outbound uses the 11-department sender registry (`src/lib/email/senders.ts`) — every queued email carries `sender`/`reply_to`/`template`/`event` (migration 0021). Only `support@` (and `partners@` for partner tickets) accepts ticket replies; the other identities are outbound-only.

### Inbound pipeline (hardened — migration 0022)

`POST https://api.zapnivo.com/webhooks/email/inbound` accepts ticket replies. Authentication is layered:

1. **Shared secret** — `EMAIL_INBOUND_SECRET` (comma-separated for rotation). Accepted via `?key=`, `Authorization: Bearer <secret>`, or `X-Zapnivo-Inbound-Key`. Brevo inbound parsing cannot sign webhooks, so this secret + TLS is the provider authentication. Never logged; rotate by appending the new secret, deploying, updating the provider, then removing the old one.
2. **Reply token** — every ticket notification email now sets `Reply-To: support+<TICKET>-<hmac>@zapnivo.com` (or `partners+…` for partner tickets). The token is an HMAC-SHA256 of ticket number + requester email + org under `HELPDESK_SECRET` — unguessable, per-ticket, expires implicitly when the ticket data changes. Replies carrying a valid token are accepted only if `From` still matches the requester; a forged or cross-ticket token is quarantined.
3. **Legacy fallback** — mail without a plus-address still matches on `Z-<n>` in subject/body + `From` = requester email. Recorded as `auth_method=legacy_from_match` in the log so staff can see which path was used.
4. **DMARC** — when the provider includes `Authentication-Results`, an explicit `dmarc=fail` quarantines the message for staff review instead of posting it. SPF/DKIM/DMARC are treated as signals, never as proof of identity.

Replay/duplicate protection: `Message-ID` has a unique index (second delivery → `duplicate`), and a content-hash dedupe window (15 min) catches retries without a Message-ID. Payloads over 2 MB are rejected with 413 before parsing. Every request — accepted, quarantined, rejected, ignored, duplicate, error — is written to `inbound_emails` (migration 0022) with auth method, DMARC/SPF/DKIM results, latency, and a 200-char body preview. Staff read it in Admin → Email Center → **Inbound**; only the service role writes.

### Inbound pipeline architecture (async, durable — migration 0023)

The webhook is split into two stages so Brevo always gets a fast ack:

- **Stage A — ingestion** (`/api/webhooks/email/inbound`): auth → size limit → normalize each `items[]` message → insert one `inbound_jobs` row per message (Message-ID unique = enqueue dedupe) → return `{queued, duplicates}` immediately. No ticket lookups, AI, or outbound email happen here.
- **Stage B — worker** (`/lib/inbound/worker.ts` via `/api/cron/inbound`, Vercel cron (daily — Hobby plan limit), plus a post-response `after()` kick): claims due jobs with an atomic `queued→processing` update (concurrent-worker safe), runs the full ticket pipeline (`/lib/inbound/processor.ts` — reply token, sender match, DMARC quarantine, legacy fallback, `requesterMessage`), then marks `done`. Errors retry with exponential backoff (30s·2^attempts, max 5) then `dead`; jobs stuck in `processing` >5min are recovered. Every outcome lands in `inbound_emails` as before.
- Queue depth (`queued`/`processing`/`dead`) shows in Admin → Email Center → Inbound.

### Brevo inbound parsing setup (manual, one-time)

Verified against https://developers.brevo.com/docs/inbound-parse-webhooks. Google Workspace stays the primary mail host on the apex — **do not touch the apex MX records** (`smtp.google.com`).

1. **Domain**: the parsing domain must differ from the sending domain and be verified in Brevo. Use `in.zapnivo.com`.
2. **DNS** — add these records for `in.zapnivo.com` only (per Brevo docs):
   - `MX 10 inbound1.sendinblue.com.`
   - `MX 20 inbound2.sendinblue.com.`
   - DNS propagation can take hours — apply early.
3. **Webhook** — create via Brevo API (or dashboard → SMTP & API → Webhooks):
   ```
   POST https://api.brevo.com/v3/webhooks
   { "type": "inbound", "events": ["inboundEmailProcessed"],
     "domain": "in.zapnivo.com",
     "description": "Zapnivo Inbound Support and Partner Email Parsing",
     "url": "https://api.zapnivo.com/webhooks/email/inbound" }
   ```
   **Configured:** webhook ID `2672275` (created 2026-11-10), type `inbound`, domain `in.zapnivo.com`, event `inboundEmailProcessed`. Brevo supports custom webhook headers — delivery is authenticated with `X-Zapnivo-Inbound-Key: $EMAIL_INBOUND_SECRET` (header, not URL — the secret never appears in the webhook URL). Any mail to `*@in.zapnivo.com` is parsed and POSTed as `{items: [...]}`. Verified live: a real Brevo-delivered message was accepted onto ticket Z-1004 with `auth_method=reply_token`.
4. **Google Workspace forwarding** — Admin → Apps → Google Workspace → Gmail → Routing (or per-mailbox forwarding):
   - `support@zapnivo.com` → `support@in.zapnivo.com`
   - `partners@zapnivo.com` → `partners@in.zapnivo.com`
   - **Critical**: use "change route"/forwarding that preserves the original message — Gmail routing/forwarding keeps the original `To:` header intact (only the envelope recipient changes). The reply token lives in that header, so do **not** rewrite the recipient to a fixed address in a way that strips headers. Brevo's `To[]`/`Headers["To"]` carry the token-bearing address; the envelope `Recipients[]` will show the `in.zapnivo.com` address.
   - Gmail delivers plus-addressed mail (`support+tag@zapnivo.com`) to the `support@` mailbox natively — customers' replies to our `Reply-To: support+<ticket>-<token>@zapnivo.com` arrive intact.
5. **Test**: reply to a real ticket email from an approved external mailbox → confirm the reply appears in the ticket thread and as `accepted` with `auth_method=reply_token` in Admin → Email Center → Inbound. **Inbound email is not operational until this passes.**

### Departmental routing plan

| Address | Destination |
|---|---|
| `support@zapnivo.com` | Customer support tickets (forward → Brevo inbound) |
| `partners@zapnivo.com` | Partner correspondence — partner-ticket replies forward here too |
| `billing@`, `operations@`, `security@`, `legal@`, `hello@`, `admin@` | Monitored mailboxes/aliases in Google Workspace; **not** auto-ticketed |
| `rentals@`, `notifications@` | Monitored reply destinations only |
| `noreply@` | Send-only; never accepts support conversations |

Only mail that resolves to a ticket (reply token or `Z-<n>` + requester match) becomes a ticket message — departmental inboxes stay plain mail until a workflow explicitly calls for ticketing.

## BIMI (Brand Indicators for Message Identification)

- **Logo asset**: `public/bimi/zapnivo.svg` — SVG Tiny PS, 256×256, lime `#D9FF73` rounded mark + `#11122B` bolt (matches `src/components/Logo.tsx`). Live at `https://www.zapnivo.com/bimi/zapnivo.svg` (200, `image/svg+xml`).
- **DNS record** (Vercel DNS, uid `rec_e1149ce859f8232c212ebddd`): `default._bimi.zapnivo.com TXT "v=BIMI1; l=https://www.zapnivo.com/bimi/zapnivo.svg"` — logo assertion only; **no `a=` certificate tag yet**.
- **DMARC**: currently `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com`. BIMI requires `p=quarantine` or `p=reject` — do **not** enforce until all legitimate senders align.
- **Alignment audit (2026-11-10, real message)**: Brevo transactional send `From: support@zapnivo.com` → Google Workspace → forwarded inbound. Google's `Authentication-Results` recorded in `inbound_emails`: **SPF pass, DKIM pass, DMARC pass**. Brevo signs DKIM with `d=zapnivo.com` (selectors `brevo1`/`brevo2` → `*.dkim.brevo.com`); SPF covers Google Workspace only (`include:_spf.google.com ~all`) — Brevo uses its own envelope domain, so DMARC alignment rides on DKIM.
- **Still required before logo display**:
  1. **CMC or VMC certificate** — Gmail only renders BIMI with a certificate. CMC (DigiCert/CSC) is the lower-cost option and does not strictly require a registered trademark; VMC (DigiCert) requires trademark registration. Both require: enforced DMARC (`p=quarantine` minimum), the hosted SVG, and organization verification. Zapnivo has no registered trademark on file — CMC is the realistic path.
  2. **DMARC enforcement** — move `p=none` → `p=quarantine` (then `reject`) only after confirming every sender aligns. Verified aligned: Brevo transactional (all 11 `@zapnivo.com` sender identities share the same path). **Unverified**: Google Workspace *outbound* user mail — `google._domainkey` DKIM exists but signing must be enabled in Admin → Apps → Google Workspace → Gmail → Authenticate email; confirm before enforcing.
  3. Once the cert is issued: host the `.pem` at `https://www.zapnivo.com/bimi/zapnivo-cert.pem`, update the TXT to `v=BIMI1; l=...; a=...`, and re-verify.
