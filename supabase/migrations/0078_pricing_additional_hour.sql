-- New pricing version: $2.99 per additional started hour (was equal to first hour).
-- Rentals lock pricing_version at checkout, so we INSERT a new version rather than
-- mutate the existing row — mutating would retroactively reprice in-flight rentals.
-- Clones every other field from the currently-effective version; the quote path
-- picks the latest row by effective_at.
insert into pricing_versions (
  id, approved, first_hour_cents, additional_hour_cents,
  first_24h_cap_cents, additional_day_cents,
  non_return_max_cents, non_return_after_hours, effective_at
)
select
  'pilot-2026-v2', approved, first_hour_cents, 299,
  first_24h_cap_cents, additional_day_cents,
  non_return_max_cents, non_return_after_hours, now()
from pricing_versions
order by effective_at desc nulls last
limit 1
on conflict (id) do nothing;
