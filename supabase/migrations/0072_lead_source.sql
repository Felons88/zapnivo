-- 0072_lead_source.sql
-- Attribution for public vending/placement inquiries. The public form already
-- accepts a `source` tag (page/placement tag, e.g. "vending_request",
-- "industry_offices"); persist it on the CRM row so staff can see which
-- surface produced the lead.

alter table partner_applications
  add column if not exists lead_source text;

create index if not exists partner_applications_lead_source_idx
  on partner_applications(lead_source);
