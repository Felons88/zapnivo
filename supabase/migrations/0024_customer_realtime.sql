-- Migration 0024 — customer read policies for realtime + portal parity.
-- Mirrors the partner policies: a signed-in customer (Supabase auth user whose
-- profiles.email matches the ticket requester email) may read their own
-- tickets and the non-internal messages on them. This enables Supabase
-- Realtime subscriptions from the customer portal without exposing other
-- customers' conversations. Internal notes stay staff/partner-only.

drop policy if exists customer_own_tickets on support_tickets;
create policy customer_own_tickets on support_tickets for select using (
  requester_type = 'customer'
  and lower(email) = (select lower(email) from profiles where id = auth.uid())
);

drop policy if exists customer_own_messages on support_messages;
create policy customer_own_messages on support_messages for select using (
  not internal
  and ticket_id in (
    select id from support_tickets
    where requester_type = 'customer'
      and lower(email) = (select lower(email) from profiles where id = auth.uid())
  )
);
