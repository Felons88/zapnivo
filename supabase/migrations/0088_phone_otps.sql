-- Phone-number change verification: one-time codes sent by SMS before a
-- profile's phone can be updated from the app. Service-role only (no RLS
-- policies = no client access); codes are stored hashed.
create table if not exists phone_change_otps (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists phone_otps_profile_idx on phone_change_otps (profile_id, created_at desc);
alter table phone_change_otps enable row level security;
