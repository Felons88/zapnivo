# Disaster recovery — Zapnivo

Status as of Phase 2.4: **recovery is NOT verified.** No restore test has succeeded yet,
and the last-known provider snapshot shows **no restorable backups and PITR disabled**
(backup state: `no_verified_backup`). This document records what is actually known, the
restore procedure, and the checklist a human must complete before DR can be called ready.

## Known provider facts (verified via Supabase CLI)

`supabase backups list --project-ref qidbieuvxeqtbqobjkns` (re-run Phase 2.4, 2026-11-12 —
identical to the Phase 2.3 finding) reports:

| Field | Value |
|---|---|
| Region | `us-east-1` (East US — North Virginia) |
| WAL-G archiving | `walg_enabled: true` |
| Point-in-time recovery | `pitr_enabled: false` |
| Listed backups | none (earliest/latest timestamps `0`) |

`supabase projects list` confirms the linked project: **Zapnivo**, ref
`qidbieuvxeqtbqobjkns`, org `svbhafhmfauksmhwrrqn`, region East US (North Virginia).

Interpretation, kept honest:

- `walg_enabled: true` means WAL archiving is configured — the prerequisite for PITR —
  but `pitr_enabled: false` means PITR is **not** active. Do not assume point-in-time
  restore is available.
- An empty backups list means **no restorable backups are currently listed** by the CLI.
  Physical backups may still exist provider-side (Supabase manages them outside this
  app's visibility), but nothing here confirms one. Confirm in
  **Dashboard → Database → Backups** before relying on any restore path.
- **What the CLI cannot see (verified Phase 2.4):** `supabase projects list`,
  `supabase orgs list`, `supabase backups list`, and `supabase inspect` (only `db` and
  `report` subcommands exist) expose **no plan tier / subscription field** and no
  per-backup schedule details. There is no CLI command that enables PITR or creates a
  backup. Plan tier and backup configuration are dashboard-only.

## Plan tier & PITR — required admin action

The app cannot determine the Supabase plan or change backup settings. An authorized
admin must:

1. Open **Supabase Dashboard → select project `qidbieuvxeqtbqobjkns` → Project
   Settings → Add-ons** (older dashboards: **Database → Backups**).
2. Check the plan tier — daily physical backups are included on Pro and above; **PITR
   (point-in-time recovery) is a paid add-on on some plans — check plan/pricing before
   enabling.** Do not assume it is included.
3. Either enable **PITR** (recommended — restores to any timestamp) or confirm
   **scheduled daily backups** are running and listed under **Database → Backups**.
4. Re-run `npx supabase backups list --project-ref qidbieuvxeqtbqobjkns` afterwards and
   update `LAST_KNOWN_PROVIDER_SNAPSHOT` in `src/lib/system/readiness.ts` (the
   `as_of` date must reflect the actual probe time). Until then the readiness page
   keeps reporting `no_verified_backup`.

## Backup/recovery readiness state machine (Phase 2.4)

`src/lib/system/readiness.ts` derives `backup.state` from recorded facts only —
`deriveBackupState()` is pure and unit-tested. Provider input is the last-known CLI
snapshot (`as_of`-stamped, injectable for tests), never a live query.

| State | Meaning | Derivation |
|---|---|---|
| `no_verified_backup` | No evidence of any restorable backup | Default — no PITR, no listed backups, or no snapshot |
| `backup_configured` | PITR enabled, but no individual backup entry confirmed | `pitr_enabled === true` in snapshot |
| `backup_available` | Provider listed ≥1 backup entry at snapshot time | `backup_count > 0` in snapshot |
| `restore_pending` | Restore attempted/recorded, none passed | ≥1 `system_recovery_tests` row AND zero `result='passed'` |
| `restore_tested` | A restore test passed | ≥1 `system_recovery_tests` row with `result='passed'` |
| `recovery_verified` | **Reserved — never auto-emitted.** Requires a recovery test row that explicitly records a verified marker; no such column exists in the 0045 schema, so the live probe always passes `false`. Even if added later, the value is **self-reported** by the operator — it is not independent verification. | explicit verified marker only |

States are ranked: `recovery_verified` > `restore_tested` > `restore_pending` >
`backup_available` > `backup_configured` > `no_verified_backup`.

The readiness page (`/system/security/readiness`) shows `backup.state` plus the
snapshot `as_of` date, and maps states onto the lifecycle vocabulary —
`restore_tested`/`recovery_verified` surface as `test_verified` at most; nothing here
can claim `production_verified` or `hardware_verified`.

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
`no_verified_backup`/`restore_pending` until a real restore test is recorded with
`result='passed'` against an isolated environment — which advances the state machine
to `restore_tested` (still self-reported). `recovery_verified` is reserved for an
explicit verified marker that does not exist in the schema today and is never
auto-emitted; reaching it requires a schema change plus an honest operator
attestation, documented here as self-reported — not independent verification.**
