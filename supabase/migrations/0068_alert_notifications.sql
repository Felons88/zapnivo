-- Migration 0068 — Phase 4.4 infrastructure ops: alert delivery ledger +
-- incident response workflow columns.
--
-- 1. alert_notifications — append-only ledger of outbound alert deliveries
--    (src/lib/system/alert-notify.ts). One row per delivery attempt or skip:
--    fingerprint dedup markers live here so a fingerprint that already
--    delivered inside the dedup window is not re-posted. `payload` stores the
--    SANITIZED outbound body only — never secrets, emails, or phone numbers
--    (built by buildAlertPayload which scrubs before insert).
--    RLS: system staff SELECT only; all writes via service role.
--
-- 2. incidents gains `resolution_notes` (required text captured when an
--    incident transitions to 'resolved') and `links` (jsonb array of linked
--    evidence: error_issue / deployment / device / change_request ids — there
--    is no FK target table that covers all of these, so links are stored as
--    typed {type,id,label} objects validated in app code).

-- ─── 1. Alert delivery ledger ──────────────────────────────────────────────
create table if not exists alert_notifications (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null,                 -- stable dedup key (error fingerprint, 'test-alert', …)
  kind text not null default 'alert' check (kind in ('alert','test')),
  severity text not null default 'warning' check (severity in ('info','warning','critical')),
  -- Sanitized outbound payload (same shape posted to the webhook).
  payload jsonb not null default '{}'::jsonb,
  status text not null check (status in ('sent','failed','skipped')),
  detail text,                               -- http status / skip reason / error — scrubbed, ≤500 chars
  sent_at timestamptz,                       -- null unless status='sent'
  created_at timestamptz not null default now()
);
create index if not exists alert_notifications_fp_idx on alert_notifications (fingerprint, created_at desc);
create index if not exists alert_notifications_status_idx on alert_notifications (status, created_at desc);

comment on table alert_notifications is
  'Append-only ledger of outbound system-alert deliveries + dedup markers. Written by src/lib/system/alert-notify.ts via service role. payload is pre-scrubbed — no PII/secrets.';

alter table alert_notifications enable row level security;

drop policy if exists system_staff_alert_notifications on alert_notifications;
create policy system_staff_alert_notifications on alert_notifications
  for select using (has_system_access());

-- ─── 2. Incident workflow columns ──────────────────────────────────────────
alter table incidents
  add column if not exists resolution_notes text,
  add column if not exists links jsonb not null default '[]'::jsonb;

comment on column incidents.resolution_notes is
  'Required when status transitions to resolved (enforced in src/lib/system/incidents.ts). Cleared on reopen.';
comment on column incidents.links is
  'Linked evidence: jsonb array of {type,id,label?} — error_issue|deployment|device|change_request|other. No FK (mixed targets); validated + deduped in app code.';
