# Disaster recovery — Zapnivo

Status as of Phase 2.3: **recovery is NOT verified.** No restore test has succeeded yet.
This document records what is actually known, the restore procedure, and the checklist a
human must complete before DR can be called ready.

## Known provider facts (verified via Supabase CLI, Phase 2.3)

`supabase backups list` against the production project reports:

| Field | Value |
|---|---|
| Region | `us-east-1` |
| WAL-G archiving | `walg_enabled: true` |
| Point-in-time recovery | `pitr_enabled: false` |
| Listed backups | `backups: []` |

Interpretation, kept honest:

- `walg_enabled: true` means WAL archiving is configured — the prerequisite for PITR —
  but `pitr_enabled: false` means PITR is **not** active. Do not assume point-in-time
  restore is available.
- `backups: []` means **no restorable backups are currently listed** by the CLI.
  Physical backups may still exist provider-side (Supabase manages them outside this
  app's visibility), but nothing here confirms one. Confirm in
  **Dashboard → Database → Backups** before relying on any restore path.
- The app holds no Supabase management API token; backup health cannot be probed from
  `/system` — the readiness page reports this section as `unverified`.

## Restore procedure

Full runbook also lives in-app at `/system/recovery` (`RESTORE_RUNBOOK` in
`src/lib/system/recovery.ts`). Summary:

1. **Freeze writes & open an incident** — declare an incident in the system console,
   pause cron jobs / maintenance writes. Record the last known-good UTC timestamp.
2. **Choose the restore point** — Dashboard → Database → Backups. With PITR disabled,
   the nearest daily backup before the corruption event is the only option; write down
   the chosen timestamp — it defines the actual RPO.
3. **Restore to a NEW project first — never in place first.** Supabase restores
   overwrite the project and are one-way. Restore into a fresh/isolated project,
   verify, then decide on cutover.
4. **Verify integrity before cutover** — compare counts on financial/audit tables
   (`payments`, `stripe_events`, `system_audit_events`, `rentals`, `refunds`),
   spot-check a known transaction, confirm auth users exist. Record elapsed time —
   that is the measured RTO.
5. **Cut over & record the test** — update env vars / DNS if a new project was used,
   redeploy, then record the exercise via `POST /api/system/recovery/tests` (or the
   form on `/system/recovery`).

**NEVER restore over production blindly.** A restore is destructive and irreversible
for data written after the restore point. Always verify on a copy first and get a
second operator to confirm the restore timestamp.

## Required credentials / access

- Supabase **Dashboard** access to the production project (owner/admin role) — needed
  to see and trigger backups/restores.
- Supabase CLI authenticated (`supabase login`) with access to the project ref —
  used for `supabase backups list` and project branching.
- For a new isolated project: permission to create projects in the Supabase
  organization.
- App-side recording needs a system role with `system.changes.request`
  (`/system/recovery` → Record test).

No service-role key or management token is stored in the app for DR; the app only
records test outcomes.

## Isolated test environment — REQUIRED

- Perform every restore test against a **separate Supabase project** (new project or
  branch), **never against production**.
- The restored copy must not receive live traffic, webhooks, cron, or customer data
  writes. Point nothing at it except verification queries.
- If PITR is ever enabled, the same rule applies: restore-to-new-project first.

## Post-restore validation checklist

After any restore (test or real), verify before cutover:

- [ ] **Schema** — all migrations through `0047` present (`supabase/migrations` vs
      `system_database_migrations` / dashboard schema); `system_*` tables exist with RLS enabled.
- [ ] **RLS** — spot-check that anon/authenticated roles cannot read `system_*` tables
      and that org-scoped policies still isolate partner data.
- [ ] **Representative reads** — `profiles`, `rentals`, `payments`, `support_tickets`
      row counts match expectations; spot-check one known payment and one known rental.
- [ ] **Auth** — auth users exist; a test sign-in works; MFA factors intact.
- [ ] **Integrity** — `stripe_events` and `system_audit_events` sequences consistent;
      no duplicated or missing financial rows.
- [ ] **App health** — deploy/point env at the restored project only after the above;
      confirm `/api/health`-style checks and one real customer flow.

## Recording a test (`system_recovery_tests`)

Fields (migration `0045_system_ops.sql`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, `gen_random_uuid()` |
| `tested_at` | timestamptz | When the test ran (defaults to now) |
| `environment` | text | e.g. `isolated-project`, `staging` — NOT production for drills |
| `method` | text | `supabase_backup_restore` \| `supabase_pitr` \| `point_in_time_dump` \| `manual_sql` \| `other` |
| `result` | text | `passed` \| `failed` \| `partial` (CHECK constraint) |
| `rpo_minutes` | int | Measured recovery point objective — null until a timed test |
| `rto_minutes` | int | Measured recovery time objective — null until a timed test |
| `notes` | text | Free text (max 4000 chars via API) |
| `actor_id` | uuid | Recording operator |
| `created_at` | timestamptz | Insert time |

Honesty rule: a row is only as trustworthy as the operator entering it. The readiness
page shows the latest test but labels it manually-recorded. **Recovery stays
`unverified` until a real restore test is recorded with `result='passed'` against an
isolated environment — and even then it is `test_verified`, not production-verified.**
