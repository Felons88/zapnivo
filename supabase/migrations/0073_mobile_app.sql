-- Migration 0073 — customer mobile app: push device tokens + public OTA release bucket.
--
--   mobile_devices — FCM registration tokens per customer. RLS on with NO policies:
--                    only the service role (src/lib/push.ts, /api/mobile/devices) reads/writes.
--   app-releases   — PUBLIC storage bucket holding latest.json + the signed APK. The app checks
--                    latest.json every 5 minutes. Public read only; uploads need the service role
--                    (scripts/publish-app.mjs). The bucket never holds secrets.

create table if not exists mobile_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  token text not null unique,
  platform text not null default 'android' check (platform in ('android','ios')),
  app_version text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists mobile_devices_user_idx on mobile_devices (user_id);

alter table mobile_devices enable row level security;
-- No policies: deny-all for anon/authenticated; service role bypasses RLS.

insert into storage.buckets (id, name, public, file_size_limit)
values ('app-releases', 'app-releases', true, 209715200)
on conflict (id) do update set public = true;

-- Realtime for the app's Rentals/active-rental screens: a customer may SELECT only their own rentals
-- (writes remain service-role only), and rentals joins the supabase_realtime publication.
drop policy if exists customer_own_rentals on rentals;
create policy customer_own_rentals on rentals for select using (customer_id = auth.uid() or renter_profile = auth.uid());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rentals') then
    execute 'alter publication supabase_realtime add table rentals';
  end if;
end $$;
