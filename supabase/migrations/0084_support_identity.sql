-- Customer-facing support title, separate from authorization role.
alter table profiles add column if not exists support_title text
  check (support_title is null or support_title in ('manager', 'support_agent'));
