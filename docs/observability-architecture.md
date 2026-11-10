# Zapnivo Observability — architecture

Internal, self-managed monitoring. No Sentry subscription. Scope is deliberately
pragmatic: proven patterns over feature parity claims.

## Components

| Layer | Implementation |
|---|---|
| Browser error capture | `src/components/Telemetry.tsx` — `error` + `unhandledrejection` → `POST /api/telemetry` (always on; operational, not analytics) |
| Core Web Vitals | Same component, `PerformanceObserver` for LCP/INP-adjacent paint metrics/CLS/TTFB/FCP — **consent-gated** (`zapnivo_consent`) |
| Server error capture | `src/instrumentation.ts` `onRequestError` → `reportError()`; explicit `reportError` calls in Stripe webhook (critical), inbound worker dead-letters (critical) |
| Telemetry SDK | `src/lib/observability.ts` — `reportError`, `recordLog`, `recordSpan`, `traced`, `scrub`, `scrubAttrs`, `fingerprint` |
| Ingestion | `POST /api/telemetry` — discriminated-union schema (error/vital/log/feedback), per-IP rate limit, scrub before insert; feedback routes into the existing helpdesk |
| Storage | Supabase Postgres — `error_events`, `error_issues`, `app_logs`, `trace_spans`, `incidents`, `uptime_checks` (migration 0026), staff-read RLS, service-role writes |
| Issue grouping | Fingerprint = sha256(exception name + message prefix + first app stack frame + route), 24 chars. Repeat events bump `event_count`/`last_seen`; resolved→recurring flips to `regressed` |
| Issue workflow | `POST /api/admin/observability` (staff-only) — investigate/resolve/ignore/reopen; UI in `/admin/observability` |
| Alerting | Critical *new* issues email staff via the existing outbox (`alertStaff` → Brevo); uptime incidents alert too. Dedupe: only first-seen fingerprints alert |
| Uptime | `GET /api/cron/uptime` — checks 6 public targets, records `uptime_checks`, creates `incidents` row after 3 consecutive failures. Auth: `CRON_SECRET` bearer or staff session. Point an external scheduler (cron-job.org free tier, GitHub Actions) at it every 5 min for real coverage — Vercel Hobby only allows daily crons |
| Cron monitoring | Existing `cron_runs` table + `recordCron`; now also wraps the inbound worker. Staff-failure emails already existed |
| Dashboard | `/admin/observability` (System nav group): error counts, critical issues, incidents, uptime %, failed crons, issue table w/ actions, recent errors/logs, monitors |

## Data flow

```
browser error ──► /api/telemetry ──► scrub ──► error_events + error_issues (fingerprint upsert)
server throw  ──► onRequestError / reportError ──► same path (runtime=server)
web vitals    ──► consent? ──► app_logs (service=web-vitals)
cron route    ──► recordCron ──► cron_runs (+ staff email on failure)
uptime route  ──► uptime_checks ──► 3-fail streak ──► incidents + staff alert
```

## Security model

- All telemetry tables: staff-select RLS only; writes exclusively via service role inside API routes.
- `scrub()` redacts emails, US phones, card numbers, `sk-*`/`whsec_*`/`SG.*` keys, `key=…/token=…` patterns before storage.
- `scrubAttrs()` drops any attr whose *key* matches secret/PII patterns — allowlist-shaped, not just regex-on-values.
- Client sends only error name/message/stack/route/UA — never request bodies, headers, or auth tokens.
- Telemetry is fail-open: every capture path swallows its own errors; auth/payment/webhook security checks are untouched.

## Deliberately not built (honest scope)

- **Session replay (rrweb)**: heavy client bundle + masking complexity; not justified at current scale. Revisit if debugging needs it.
- **OpenTelemetry Collector / ClickHouse**: Postgres handles current volume (small business). Revisit if `error_events`/`app_logs` exceed ~1M rows/month — add retention job first.
- **Continuous profiling**: not reliably available on Vercel serverless; `traced()` span timing covers the useful 80%.
- **Source-map upload pipeline**: errors store raw stacks; Next build doesn't emit public sourcemaps. Add `hidden-source-map` upload to a private store if stack readability becomes a problem.
- **AI debugging agent**: dashboard data is there; an OpenRouter summarizer can be layered on later.
- **Distributed tracing across providers**: `trace_spans` schema exists and `traced()` is ready, but propagation into Stripe/Brevo/Twilio isn't possible — those are external black boxes.

## Retention & cost

- Postgres storage only; estimated < $0/month at current volume on existing Supabase tier.
- No new external services required. Optional free-tier external uptime pinger recommended.
- Add a `delete … where ts < now() - interval '30 days'` cron for `error_events`/`app_logs`/`uptime_checks` when volume warrants (not yet needed).
