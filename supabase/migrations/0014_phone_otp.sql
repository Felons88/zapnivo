-- Migration 0014 — phone login + rental risk guard.

alter table profiles add column if not exists phone text;
create unique index if not exists profiles_phone_key on profiles (phone) where phone is not null;

-- Phone OTP codes for passwordless customer sign-in (hashed, expiring, rate-limited).
create table if not exists phone_otps (
  id bigint generated always as identity primary key,
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists phone_otps_lookup on phone_otps (phone, used, expires_at);
alter table phone_otps enable row level security;
-- no user-facing policy: only service role touches this table
