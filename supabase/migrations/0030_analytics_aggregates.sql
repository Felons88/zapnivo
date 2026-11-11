-- Intelligence platform stage 4 — analytics aggregation + cohorts.
-- Aggregates business_events (0025) into daily rollups; never stores raw PII.

create table analytics_daily (
  day date not null,
  event_type text not null,
  dimension text not null default '',        -- e.g. 'source=google', 'variant=control', '' = all
  count bigint not null default 0,
  unique_users bigint not null default 0,    -- distinct actor_id/session_ref where present
  primary key (day, event_type, dimension)
);

create table analytics_cohorts (
  cohort_date date not null,                 -- first-seen day per subject
  subject text not null,                     -- actor_id (authed) or session_ref (anon); never email/phone
  first_event text not null,
  days_active int not null default 1,
  last_seen date not null,
  primary key (cohort_date, subject)
);

alter table analytics_daily enable row level security;
alter table analytics_cohorts enable row level security;
create policy staff_analytics_daily on analytics_daily for select using (is_staff());
create policy staff_analytics_cohorts on analytics_cohorts for select using (is_staff());
