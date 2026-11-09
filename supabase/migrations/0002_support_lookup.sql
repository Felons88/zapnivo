-- Migration 0002 — support lookups
-- Gives every rental a short customer-facing reference and makes receipt-email matching
-- case-insensitive and indexed. Lookups run server-side (service role) and require an exact
-- email match, so they can't be used to enumerate other customers' rentals.

alter table rentals
  add column if not exists reference text unique
  default ('ZR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)));

update rentals set reference = 'ZR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)) where reference is null;
alter table rentals alter column reference set not null;

alter table payments alter column receipt_email type citext;

create index if not exists payments_receipt_email_idx on payments (receipt_email);
create index if not exists rentals_created_at_idx on rentals (created_at);
create index if not exists tickets_email_idx on support_tickets (email);
