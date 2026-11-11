-- Partial entitlement commit: settlement may consume less than a reservation held.
create or replace function commit_entitlement_partial(p_reservation_id uuid, p_amount int, p_actor text default 'system')
returns int language plpgsql security definer set search_path = public as $$
declare r record; take int;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount'; end if;
  select * into r from entitlement_reservations where id = p_reservation_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if r.status <> 'reserved' then return 0; end if;
  take := least(p_amount, r.amount);
  update entitlement_grants
    set reserved = reserved - take, remaining = remaining - take,
        status = case when remaining - take = 0 and reserved - take = 0 then 'depleted' else status end,
        updated_at = now()
    where id = r.grant_id;
  if take = r.amount then
    update entitlement_reservations set status = 'committed', resolved_at = now(), amount = 0 where id = r.id;
  else
    update entitlement_reservations set amount = amount - take where id = r.id;
  end if;
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, ref_type, ref_id, actor)
    values (r.grant_id, r.profile_id, 'redeem', -take, null, 'rental', r.rental_id::text, p_actor);
  return take;
end $$;
