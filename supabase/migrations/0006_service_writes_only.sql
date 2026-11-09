-- Migration 0006 — only the service layer writes
-- Staff JWTs previously had `for all` policies: a stolen or misused staff token could
-- insert an 'approved' refund_request, flip internal notes public, or edit tickets
-- directly via PostgREST — bypassing service-layer validation, the second-person
-- refund rule, and the audit trail. The app only ever writes via the service role
-- (which bypasses RLS), so every JWT policy becomes SELECT-only.

-- profiles / org / venue / hardware
drop policy staff_all_profiles on profiles;
create policy staff_all_profiles on profiles for select using (is_staff());
drop policy staff_all_orgs on organizations;
create policy staff_all_orgs on organizations for select using (is_staff());
drop policy staff_venues on venues;
create policy staff_venues on venues for select using (is_staff());
drop policy staff_contacts on venue_contacts;
create policy staff_contacts on venue_contacts for select using (is_staff());
drop policy staff_kiosks on kiosks;
create policy staff_kiosks on kiosks for select using (is_staff());
drop policy staff_slots on kiosk_slots;
create policy staff_slots on kiosk_slots for select using (is_staff());
drop policy staff_banks on power_banks;
create policy staff_banks on power_banks for select using (is_staff());
drop policy staff_events on device_events;
create policy staff_events on device_events for select using (is_staff());
drop policy staff_commands on device_commands;
create policy staff_commands on device_commands for select using (is_staff() and my_role() = 'admin');
drop policy staff_maintenance on maintenance_visits;
create policy staff_maintenance on maintenance_visits for select using (is_staff());

-- pricing / rentals / money
drop policy staff_pricing on pricing_versions;
create policy staff_pricing on pricing_versions for select using (is_staff());
drop policy staff_rentals on rentals;
create policy staff_rentals on rentals for select using (is_staff());
drop policy staff_payments on payments;
create policy staff_payments on payments for select using (is_staff());
drop policy staff_refunds on refunds;
create policy staff_refunds on refunds for select using (is_staff());
drop policy staff_disputes on disputes;
create policy staff_disputes on disputes for select using (is_staff());

-- partner financial
drop policy staff_agreements on partner_agreements;
create policy staff_agreements on partner_agreements for select using (is_staff());
drop policy staff_ledgers on commission_ledgers;
create policy staff_ledgers on commission_ledgers for select using (is_staff());
drop policy staff_apps_upd on partner_applications;

-- intake & comms
drop policy staff_ads_inq on advertising_inquiries;
create policy staff_ads_inq on advertising_inquiries for select using (is_staff());
drop policy staff_contact on contact_messages;
create policy staff_contact on contact_messages for select using (is_staff());
drop policy staff_campaigns on advertising_campaigns;
create policy staff_campaigns on advertising_campaigns for select using (is_staff());
drop policy staff_assets on advertising_assets;
create policy staff_assets on advertising_assets for select using (is_staff());
drop policy staff_playback on playback_events;
create policy staff_playback on playback_events for select using (is_staff());
drop policy staff_config on system_config;
create policy staff_config on system_config for select using (my_role() = 'admin');

-- helpdesk
drop policy staff_tickets on support_tickets;
create policy staff_tickets on support_tickets for select using (is_staff());
drop policy staff_messages on support_messages;
create policy staff_messages on support_messages for select using (is_staff());
drop policy staff_refund_requests on refund_requests;
create policy staff_refund_requests on refund_requests for select using (is_staff());
drop policy staff_outbox on email_outbox;
create policy staff_outbox on email_outbox for select using (is_staff());

-- Grant-level belt & suspenders: JWT roles cannot write even if a future
-- policy accidentally permits it. Service role is unaffected (bypasses RLS,
-- holds its own grants). Applies to existing tables and future ones.
revoke insert, update, delete on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke insert, update, delete on tables from anon, authenticated;
