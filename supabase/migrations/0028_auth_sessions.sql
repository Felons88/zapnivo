-- Server-authoritative session registry — migration 0028
-- Absolute 24h session lifetime anchored to first-seen authentication, NOT JWT iat
-- (Supabase refreshes mint new iat values and must never extend the deadline).

create table auth_sessions (
  session_key text primary key,                    -- 'sso:<supabase session_id>' or 'anchor:<hmac>'
  user_id uuid not null references profiles(id) on delete cascade,
  auth_method text,                                -- password | oauth | otp | unknown
  created_at timestamptz not null default now(),   -- first-seen auth timestamp = deadline anchor
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,                 -- created_at + 24h, fixed at insert
  revoked_at timestamptz
);
create index auth_sessions_user_idx on auth_sessions (user_id, expires_at);

alter table auth_sessions enable row level security;
-- Users may inspect their own sessions; staff see all. Writes are service-role only.
create policy own_sessions on auth_sessions for select using (user_id = auth.uid() or is_staff());
