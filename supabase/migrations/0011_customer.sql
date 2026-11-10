-- Customer incident reports (lost / damaged / stolen charger). Written only by the service role
-- (POST /api/incidents); staff may read. Customers never read this table directly.
create table if not exists incident_reports (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references rentals(id),
  ticket_id uuid references support_tickets(id) on delete set null,
  kind text not null check (kind in ('lost','damaged','stolen','other')),
  description text not null check (char_length(description) between 10 and 2000),
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists incident_reports_rental_idx on incident_reports (rental_id);
create index if not exists incident_reports_ticket_idx on incident_reports (ticket_id);

alter table incident_reports enable row level security;
drop policy if exists staff_read_incidents on incident_reports;
create policy staff_read_incidents on incident_reports for select using (is_staff());
