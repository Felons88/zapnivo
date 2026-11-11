-- Atomic event-pass issuance: serializes concurrent issues per event and
-- enforces max_redemptions inside the same transaction as the insert.
create or replace function issue_event_pass(
  p_event uuid, p_units int, p_expires_at timestamptz, p_code_hash text
) returns uuid language plpgsql security definer set search_path = public as $$
declare e record; cap int; cnt int; pid uuid;
begin
  -- Serialize issuance per event so the cap check can't race.
  perform pg_advisory_xact_lock(hashtext('event_pass_issue:' || p_event::text));

  select status, max_redemptions into e from event_programs where id = p_event;
  if not found then raise exception 'event_missing'; end if;
  if e.status = 'closed' or e.status = 'cancelled' then raise exception 'event_closed'; end if;

  if e.max_redemptions is not null then
    select count(*) into cnt from event_passes
      where event_id = p_event and status <> 'revoked';
    if cnt >= e.max_redemptions then raise exception 'cap_reached'; end if;
  end if;

  insert into event_passes (event_id, code_hash, units_granted, expires_at, status)
    values (p_event, p_code_hash, p_units, p_expires_at, 'active')
    returning id into pid;
  return pid;
end $$;
