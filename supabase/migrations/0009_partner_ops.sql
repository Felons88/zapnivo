-- Migration 0009 — partner operations: onboarding checklist + document requests
-- All writes go through service-role API routes; JWT policies are SELECT-only.

create table partner_onboarding_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  step text not null check (step in ('welcome_call','site_survey','signage_sent','staff_training','go_live_check')),
  completed_at timestamptz not null default now(),
  completed_by uuid references profiles(id) on delete set null,
  unique (organization_id, step)
);

create table partner_document_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('insurance_certificate','w9','business_license','other')),
  status text not null default 'requested' check (status in ('requested','received','waived')),
  note text,
  storage_path text,
  requested_at timestamptz not null default now(),
  received_at timestamptz,
  requested_by uuid references profiles(id) on delete set null
);
create index partner_doc_req_org on partner_document_requests (organization_id, status);

alter table partner_onboarding_steps enable row level security;
alter table partner_document_requests enable row level security;

create policy staff_onboarding_steps on partner_onboarding_steps for select using (is_staff());
create policy partner_read_onboarding_steps on partner_onboarding_steps for select using (
  organization_id = (select organization_id from profiles where id = auth.uid()));
create policy staff_doc_requests on partner_document_requests for select using (is_staff());
create policy partner_read_doc_requests on partner_document_requests for select using (
  organization_id = (select organization_id from profiles where id = auth.uid()));

insert into storage.buckets (id, name, public) values ('partner-documents', 'partner-documents', false)
  on conflict do nothing;
