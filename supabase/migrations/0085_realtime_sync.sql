-- Migration 0084 — realtime sync for the CRM/support/account surfaces.
--
-- Every portal page mounts a LiveSync client that subscribes to postgres_changes
-- and calls router.refresh(), so staff/customer views update without a manual
-- reload (the same pattern the ticket inbox already uses). Realtime respects RLS
-- select policies, so subscribers only receive rows they are allowed to read —
-- staff get staff-scoped tables, customers get their own rentals/credits, and
-- anyone else gets nothing (the polling backstop covers them).
--
-- Already published elsewhere: support_tickets + support_messages (0023),
-- system_devices / system_device_commands / system_device_messages (0066),
-- rentals (0073).

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'payments',
      'refund_requests',
      'disputes',
      'incident_reports',
      'customer_notes',
      'customer_data_requests',
      'sms_messages',
      'profiles',
      'entitlement_grants',
      'wallet_topups'
    ] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
        execute format('alter publication supabase_realtime add table %I', t);
      end if;
    end loop;
  end if;
end $$;
