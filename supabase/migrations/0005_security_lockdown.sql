-- Migration 0005 — security lockdown
-- Live-audit findings: `for all` policies let any signed-in user update their own
-- profile (role escalation to admin) and let partners rewrite their own agreements,
-- ledgers, venues and hardware rows. Non-staff now get SELECT-only; all writes go
-- through the service layer (service role), never a user's own JWT.

-- ─── profiles: self = read-only ───────────────────────────────────────────────
drop policy staff_all_profiles on profiles;
create policy staff_all_profiles on profiles for all using (is_staff());
create policy own_profile_read on profiles for select using (id = auth.uid());

-- Defense in depth: role / org / mfa can change only via service-role or direct
-- DB access (dashboard SQL, migrations). A user's own JWT can never touch them,
-- even if a future policy accidentally grants self-update.
create or replace function profiles_block_privilege_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.role is distinct from old.role
      or new.organization_id is distinct from old.organization_id
      or new.mfa_required is distinct from old.mfa_required)
     and coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'privileged profile fields can only change server-side';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on profiles;
create trigger profiles_guard before update on profiles
  for each row execute function profiles_block_privilege_change();

-- ─── partner-visible tables: SELECT-only for partners ─────────────────────────
drop policy staff_all_orgs on organizations;
create policy staff_all_orgs on organizations for all using (is_staff());
create policy partner_read_org on organizations for select using (
  exists (select 1 from profiles p where p.id = auth.uid() and p.organization_id = organizations.id));

drop policy venues_policy on venues;
create policy staff_venues on venues for all using (is_staff());
create policy partner_read_venues on venues for select using (
  organization_id = (select organization_id from profiles where id = auth.uid()));

drop policy contacts_policy on venue_contacts;
create policy staff_contacts on venue_contacts for all using (is_staff());
create policy partner_read_contacts on venue_contacts for select using (
  exists (select 1 from venues v where v.id = venue_id
          and v.organization_id = (select organization_id from profiles where id = auth.uid())));

drop policy staff_kiosks on kiosks;
create policy staff_kiosks on kiosks for all using (is_staff());
create policy partner_read_kiosks on kiosks for select using (
  venue_id in (select id from venues where organization_id = (select organization_id from profiles where id = auth.uid())));

drop policy staff_slots on kiosk_slots;
create policy staff_slots on kiosk_slots for all using (is_staff());
create policy partner_read_slots on kiosk_slots for select using (
  kiosk_id in (select k.id from kiosks k join venues v on v.id = k.venue_id
               where v.organization_id = (select organization_id from profiles where id = auth.uid())));

-- ─── financial terms & records: read-only for partners ────────────────────────
drop policy agreements_policy on partner_agreements;
create policy staff_agreements on partner_agreements for all using (is_staff());
create policy partner_read_agreements on partner_agreements for select using (
  organization_id = (select organization_id from profiles where id = auth.uid()));

drop policy ledgers_policy on commission_ledgers;
create policy staff_ledgers on commission_ledgers for all using (is_staff());
create policy partner_read_ledgers on commission_ledgers for select using (
  venue_id in (select id from venues where organization_id = (select organization_id from profiles where id = auth.uid())));
