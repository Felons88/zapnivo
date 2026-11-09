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
| `NEXT_PUBLIC_SITE_URL` | `https://zapnivo.com` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://qidbieuvxeqtbqobjkns.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | from `.env.local` — **server-only** |
| `HELPDESK_SECRET` | from `.env.local` — required for customer thread links |
| `KIOSK_ADAPTER` | `none` |

Optional / later: `NEXT_PUBLIC_MAPBOX_TOKEN` (map), `OPENROUTER_API_KEY` (+`OPENROUTER_MODEL`), `RESEND_API_KEY` + `SUPPORT_FROM_EMAIL` (email), `STRIPE_*` (payments).

**Do NOT set `HELPDESK_DEV_STORE`** — it's dev-only and ignored in production builds anyway.

## 4. Provider-side settings

- **Supabase Auth** → URL Configuration → Site URL: `https://zapnivo.com`, add `https://zapnivo.com/**` to redirect allowlist.
- **Mapbox token** → restrict to `https://zapnivo.com` and `https://*.vercel.app` (previews).
- **Domain** → Vercel project → Domains → add `zapnivo.com` (+`www` redirect), then point DNS at Vercel per its instructions.

## 5. Post-deploy smoke test

1. `curl -I https://zapnivo.com` → 200, has `Content-Security-Policy` header.
2. `https://zapnivo.com/api/dev/as?role=admin` → **404** (dev seams must be dead).
3. `/support` → create a test ticket → it should persist (Supabase) and return `Z-####` + signed link.
4. `/login` → sign in as admin → `/admin/support` inbox shows the ticket.
5. Rental lookup + AI chat show honest "not configured" until their keys are set — that's correct, not a bug.

## Notes

- Rate limiting is in-memory per instance — fine at Vercel scale for launch; move to Upstash Redis if abuse appears (`src/lib/rate-limit.ts` is the seam).
- `email_outbox` delivers nothing until `RESEND_API_KEY` is set; staff can flush it from the metrics page.
- Preview deployments get the same env vars — that's fine (same Supabase project) unless you want a separate preview DB.
