-- ─── Gift claim policy (bearer vs recipient-bound) ─────────────────────────
-- gift_credits.claim_policy:
--   'bearer'    — whoever holds the claim token may redeem it (historical default;
--                 preserves existing rows and the purchaser-share flow).
--   'recipient' — only the profile whose email matches recipient_email may claim.
--                 Set by the Stripe webhook when it mints a claim token for a
--                 gift that has a recipient_email.
alter table gift_credits
  add column if not exists claim_policy text not null default 'bearer'
    check (claim_policy in ('bearer', 'recipient'));

-- claim_gift gains an optional recipient check: for claim_policy='recipient' the
-- claiming profile's email (profiles.email) must case-insensitively equal
-- gift_credits.recipient_email. Mismatches return a DISTINCT 'recipient_mismatch'
-- error so the API can give an honest message, while still not confirming the
-- token itself was valid beyond what the caller already proved (they hold it).
-- All existing validations, ordering, atomicity and grant logic are unchanged.
create or replace function claim_gift(p_token_hash text, p_profile uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g record; gid uuid; v_email text;
begin
  select * into g from gift_credits where claim_token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  if g.status <> 'paid' then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  if g.claim_token_expires_at is not null and g.claim_token_expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if g.expires_at is not null and g.expires_at <= now() then
    update gift_credits set status = 'expired' where id = g.id;
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if g.value_cents is null or g.value_cents <= 0 then return jsonb_build_object('ok', false, 'error', 'no_value'); end if;

  -- Recipient binding: only enforced when the gift was issued under 'recipient'
  -- policy (minted by the webhook for recipient_email gifts). profiles.email is
  -- text; recipient_email is citext — lower() both sides for a case-insensitive
  -- comparison that ignores any citext collation surprises.
  if g.claim_policy = 'recipient' then
    select lower(email) into v_email from profiles where id = p_profile;
    if v_email is null or g.recipient_email is null or v_email <> lower(g.recipient_email::text) then
      return jsonb_build_object('ok', false, 'error', 'recipient_mismatch');
    end if;
  end if;

  update gift_credits
    set status = 'redeemed', redeemed_by = p_profile, redeemed_at = now(),
        claim_token_hash = null, claim_token_expires_at = null
    where id = g.id and status = 'paid';
  if not found then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;

  insert into entitlement_grants (profile_id, kind, unit, granted, remaining, expires_at, source_type, source_id)
    values (p_profile, 'gift', 'cent', g.value_cents, g.value_cents, g.expires_at, 'gift_credit', g.id::text)
    returning id into gid;
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, ref_type, ref_id, actor)
    values (gid, p_profile, 'grant', g.value_cents, g.value_cents, 'gift_credit', g.id::text, 'customer');
  return jsonb_build_object('ok', true, 'cents', g.value_cents, 'expires_at', g.expires_at);
end $$;
