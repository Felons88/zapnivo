-- Migration 0020 — phone-claim binding for verified phone sign-in.
-- A phone_claims row records "this email proved inbox ownership while this phone proved SMS ownership".
-- Written by /api/auth/phone verify, consumed once by /api/auth/callback. Service-role only.

create table if not exists phone_claims (
  id bigint generated always as identity primary key,
  email text not null,
  phone text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists phone_claims_email on phone_claims (email, expires_at);
alter table phone_claims enable row level security;
-- No policies: service-role only, same posture as phone_otps.
