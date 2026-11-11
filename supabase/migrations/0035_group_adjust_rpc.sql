-- Atomic group credit adjustment (staff-only path; self-serve uses fund_group_credit).
create or replace function adjust_group_credit(p_group uuid, p_delta int, p_actor text, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare g record; next_cents int;
begin
  if p_delta is null or p_delta = 0 or abs(p_delta) > 10000000 then raise exception 'invalid_delta'; end if;
  select * into g from rental_groups where id = p_group for update;
  if not found then raise exception 'group_not_found'; end if;
  next_cents := g.credit_cents + p_delta;
  if next_cents < 0 then raise exception 'negative_balance'; end if;
  update rental_groups set credit_cents = next_cents where id = p_group;
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, ref_type, ref_id, actor, note)
    values (null, g.organizer_id, 'adjust', p_delta, next_cents, 'group_credit', p_group::text,
            left(p_actor, 80), left(coalesce(p_note, 'group credit adjustment'), 300));
  return next_cents;
end $$;
