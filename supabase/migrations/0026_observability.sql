-- Migration 0026 — Zapnivo Observability (internal Sentry-style monitoring).
-- Staff-only read via RLS; all writes go through the service role in /api/telemetry
-- and server-side helpers. No PII columns: messages/stacks are scrubbed before insert.
-- cron_runs already exists (0008) and is reused for scheduled-job monitoring.

create table if not exists error_events (
  id bigint generated always as identity primary key,
  fingerprint text not null,                 -- stable group key (type+top frame+route)
  issue_id uuid,                             -- linked error_issues row when grouped
  title text not null,
  message text,
  stack text,
  route text,
  release text,
  environment text not null default 'production',
  runtime text not null default 'server' check (runtime in ('browser','server','edge')),
  severity text not null default 'error' check (severity in ('error','critical','warning')),
  user_agent text,
  occurred_at timestamptz not null default now()
);
create index if not exists error_events_fp_idx on error_events (fingerprint, occurred_at desc);
create index if not exists error_events_time_idx on error_events (occurred_at desc);

create table if not exists error_issues (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  title text not null,
  culprit text,                              -- route/component
  status text not null default 'new' check (status in ('new','investigating','assigned','resolved','ignored','regressed')),
  severity text not null default 'error',
  assigned_to uuid references profiles(id),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  event_count int not null default 0,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists app_logs (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  level text not null check (level in ('debug','info','warning','error','critical')),
  service text not null default 'web',
  message text not null,
  attrs jsonb not null default '{}'::jsonb,  -- allowlisted scalar attrs only
  trace_id text,
  route text
);
create index if not exists app_logs_ts_idx on app_logs (ts desc);
create index if not exists app_logs_level_idx on app_logs (level, ts desc);

create table if not exists trace_spans (
  id bigint generated always as identity primary key,
  trace_id text not null,
  parent_span_id text,
  span_id text not null,
  name text not null,
  service text not null default 'web',
  kind text not null default 'internal',
  start_ms double precision not null,
  duration_ms double precision not null,
  status text not null default 'ok',
  attrs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists trace_spans_trace_idx on trace_spans (trace_id);
create index if not exists trace_spans_time_idx on trace_spans (created_at desc);

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default ('INC-' || nextval('support_ticket_seq')),
  title text not null,
  severity text not null default 'sev3' check (severity in ('sev1','sev2','sev3','sev4')),
  status text not null default 'detected' check (status in ('detected','investigating','identified','mitigating','monitoring','resolved')),
  source text,                               -- 'uptime' | 'cron' | 'error_spike' | 'manual'
  services text[] not null default '{}',
  owner uuid references profiles(id),
  summary text,
  detected_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists incidents_status_idx on incidents (status, detected_at desc);

create table if not exists uptime_checks (
  id bigint generated always as identity primary key,
  url text not null,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  status_code int,
  latency_ms int,
  tls_days_left int
);
create index if not exists uptime_checks_url_idx on uptime_checks (url, checked_at desc);

-- RLS: staff read everything; writes only via service role.
alter table error_events enable row level security;
alter table error_issues enable row level security;
alter table app_logs enable row level security;
alter table trace_spans enable row level security;
alter table incidents enable row level security;
alter table uptime_checks enable row level security;

drop policy if exists staff_error_events on error_events;
create policy staff_error_events on error_events for select using (is_staff());
drop policy if exists staff_error_issues on error_issues;
create policy staff_error_issues on error_issues for select using (is_staff());
drop policy if exists staff_app_logs on app_logs;
create policy staff_app_logs on app_logs for select using (is_staff());
drop policy if exists staff_trace_spans on trace_spans;
create policy staff_trace_spans on trace_spans for select using (is_staff());
drop policy if exists staff_incidents on incidents;
create policy staff_incidents on incidents for select using (is_staff());
drop policy if exists staff_uptime_checks on uptime_checks;
create policy staff_uptime_checks on uptime_checks for select using (is_staff());
