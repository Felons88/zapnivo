-- Migration 0060 — newsletter subscriber pipeline (double opt-in).
--
-- One row per email address. Tokens are stored ONLY as SHA-256 hashes — the raw
-- confirm/unsubscribe tokens exist solely inside the emailed links. Unconfirmed
-- (pending) rows are NOT subscribers and must be excluded from all counts/stats.
-- Service role only: RLS enabled with a staff read policy; all writes go through
-- /api/newsletter/* and /api/system/newsletter/* routes.

create table if not exists newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  segment text not null default 'customer' check (segment in ('customer','business','both')),
  status text not null default 'pending' check (status in ('pending','confirmed','unsubscribed')),
  confirm_token_hash text,
  confirmed_at timestamptz,
  unsubscribe_token_hash text,
  unsubscribed_at timestamptz,
  source text not null default 'website_popup',
  consent_text_version text,
  consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists newsletter_subscribers_email_key on newsletter_subscribers (email);
create index if not exists newsletter_subscribers_status_idx on newsletter_subscribers (status);
create index if not exists newsletter_subscribers_segment_idx on newsletter_subscribers (segment);
create index if not exists newsletter_subscribers_created_idx on newsletter_subscribers (created_at desc);

alter table newsletter_subscribers enable row level security;

drop policy if exists staff_newsletter on newsletter_subscribers;
create policy staff_newsletter on newsletter_subscribers for select using (is_staff());
