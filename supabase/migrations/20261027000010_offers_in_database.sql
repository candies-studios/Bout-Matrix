-- 0010 — Bout offers without Edge Functions.
-- Admins issue offers from the app and get each fighter's personal link (to copy or share on WhatsApp);
-- fighters open the link and accept or decline. Everything runs inside Postgres:
--   * tokens   = base64url(HMAC-SHA256(secret, "<offer id>:<nonce>")), same format as the Edge Functions;
--   * the secret lives in private.app_secrets (no API role can read it);
--   * only sha256(token) is stored on the offer, exactly as before.
-- Emails are still queued in email_logs and go out once the email dispatcher is deployed.

create extension if not exists pgcrypto with schema extensions;

create table if not exists private.app_secrets (
  name       text primary key,
  value      text not null check (length(value) >= 32),
  created_at timestamptz not null default now()
);
revoke all on private.app_secrets from public, anon, authenticated;
insert into private.app_secrets (name, value)
values ('offer_token_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

create or replace function private.b64url(p bytea) returns text
language sql immutable set search_path = '' as $$
  select translate(replace(encode(p, 'base64'), E'\n', ''), '+/=', '-_')
$$;

create or replace function private.sha256_hex(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;

create or replace function private.offer_token(p_offer uuid, p_nonce text) returns text
language sql stable security definer set search_path = '' as $$
  select private.b64url(extensions.hmac(convert_to(p_offer::text || ':' || p_nonce, 'UTF8'),
                                        convert_to(s.value, 'UTF8'), 'sha256'))
    from private.app_secrets s where s.name = 'offer_token_secret'
$$;

-- Request IP (from PostgREST headers), hashed with the secret — never stored in clear.
create or replace function private.request_ip_hash() returns text
language plpgsql stable security definer set search_path = '' as $$
declare h json; ip text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then h := null;
  end;
  ip := coalesce(h ->> 'cf-connecting-ip', split_part(h ->> 'x-forwarded-for', ',', 1), h ->> 'x-real-ip');
  if ip is null or trim(ip) = '' then return null; end if;
  return private.sha256_hex((select value from private.app_secrets where name = 'offer_token_secret') || ':' || trim(ip));
end $$;

create or replace function private.request_user_agent() returns text
language plpgsql stable set search_path = '' as $$
begin
  return left(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'user-agent', ''), 400);
exception when others then return '';
end $$;

-- Shared by the app (issue_offers) and the Edge Function (svc_issue_offers_auto).
create or replace function private.issue_offers_for(p_actor uuid, p_bout uuid, p_hours integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hours int;
  v_offers jsonb := '[]'::jsonb;
  v_links jsonb := '[]'::jsonb;
  v_id uuid;
  v_nonce text;
  v_token text;
  v_corner text;
  v_result jsonb;
  b public.bouts;
begin
  if p_actor is null then perform private.raise_app('forbidden', 'Sign in first.'); end if;
  select bt.* into b from public.bouts bt where bt.id = p_bout;
  if not found then perform private.raise_app('forbidden', 'Bout not found.'); end if;
  v_hours := coalesce(p_hours, (select offer_validity_hours from public.events where id = b.event_id), 72);
  if v_hours < 1 or v_hours > 720 then perform private.raise_app('invalid', 'Offer validity must be between 1 and 720 hours.'); end if;

  foreach v_corner in array array['A', 'B'] loop
    v_id := gen_random_uuid();
    v_nonce := private.b64url(extensions.gen_random_bytes(24));
    v_token := private.offer_token(v_id, v_nonce);
    v_offers := v_offers || jsonb_build_object('id', v_id, 'corner', v_corner, 'nonce', v_nonce,
                                               'token_hash', private.sha256_hex(v_token));
    v_links := v_links || jsonb_build_object('offer_id', v_id, 'corner', v_corner, 'token', v_token,
      'fight_name', (select f.fight_name from public.fighters f
                      where f.id = case v_corner when 'A' then b.fighter_a_id else b.fighter_b_id end),
      'fighter_code', (select f.fighter_code from public.fighters f
                      where f.id = case v_corner when 'A' then b.fighter_a_id else b.fighter_b_id end));
  end loop;

  -- All permission, state and eligibility checks happen here (unchanged from the Edge Function path).
  v_result := public.svc_issue_offers(p_actor, p_bout, now() + make_interval(hours => v_hours), v_offers);
  return v_result || jsonb_build_object('links', v_links);
end $$;

-- App: "Send offers". Returns each fighter's personal link token.
create or replace function public.issue_offers(p_bout uuid, p_hours integer default null) returns jsonb
language sql security definer set search_path = '' as $$
  select private.issue_offers_for(auth.uid(), p_bout, p_hours)
$$;

-- Edge Function variant (service role), so both paths produce links from the same secret.
create or replace function public.svc_issue_offers_auto(p_actor uuid, p_bout uuid, p_hours integer default null) returns jsonb
language sql security definer set search_path = '' as $$
  select private.issue_offers_for(p_actor, p_bout, p_hours)
$$;

-- App: "Copy link" / "WhatsApp" for a pending offer (same link every time).
create or replace function public.get_offer_link(p_offer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.bout_offers; b public.bouts; f public.fighters;
begin
  select * into o from public.bout_offers where id = p_offer;
  if not found then perform private.raise_app('forbidden', 'Offer not found.'); end if;
  select * into b from public.bouts where id = o.bout_id;
  if auth.uid() is null or not private.can_matchmake_event(b.event_id, auth.uid()) then
    perform private.raise_app('forbidden', 'Offer not found.');
  end if;
  if o.status <> 'pending' or o.expires_at <= now() or o.offer_version <> b.offer_version then
    perform private.raise_app('invalid', 'This offer is no longer open, so its link no longer works.');
  end if;
  select * into f from public.fighters where id = o.fighter_id;
  return jsonb_build_object('offer_id', o.id, 'corner', o.corner, 'token', private.offer_token(o.id, o.token_nonce),
                            'fight_name', f.fight_name, 'fighter_code', f.fighter_code, 'expires_at', o.expires_at);
end $$;

-- Public offer page (no sign-in). Tokens are 256-bit, so guessing is not feasible;
-- requests are also rate limited per IP when the IP is known.
create or replace function public.public_get_offer(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ip text := private.request_ip_hash();
begin
  if v_ip is not null and not public.svc_rate_limit('offer-view:' || v_ip, 60, 600) then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return public.svc_get_offer(private.sha256_hex(p_token));
end $$;

create or replace function public.public_respond_offer(p_token text, p_response text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ip text := private.request_ip_hash();
begin
  if v_ip is not null and not public.svc_rate_limit('offer-respond:' || v_ip, 20, 600) then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if p_response not in ('accept', 'decline') then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;
  return public.svc_respond_offer(private.sha256_hex(p_token), p_response::public.offer_response,
                                  left(nullif(trim(p_reason), ''), 1000), v_ip, private.request_user_agent());
end $$;

-- The email dispatcher now gets the ready-made token from the database (no separate secret to keep in sync).
create or replace function public.svc_offer_token_material(p_offer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('offer_id', id, 'nonce', token_nonce, 'status', status, 'expires_at', expires_at,
                            'token', private.offer_token(id, token_nonce))
    from public.bout_offers where id = p_offer
$$;

revoke all on function private.b64url(bytea), private.sha256_hex(text), private.offer_token(uuid, text),
  private.request_ip_hash(), private.request_user_agent(), private.issue_offers_for(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function private.b64url(bytea), private.sha256_hex(text), private.offer_token(uuid, text),
  private.request_ip_hash(), private.request_user_agent(), private.issue_offers_for(uuid, uuid, integer)
  to service_role;

revoke all on function public.issue_offers(uuid, integer), public.svc_issue_offers_auto(uuid, uuid, integer),
  public.get_offer_link(uuid), public.public_get_offer(text), public.public_respond_offer(text, text, text),
  public.svc_offer_token_material(uuid)
  from public, anon, authenticated;
grant execute on function public.issue_offers(uuid, integer), public.get_offer_link(uuid) to authenticated;
grant execute on function public.public_get_offer(text), public.public_respond_offer(text, text, text) to anon, authenticated;
grant execute on function public.issue_offers(uuid, integer), public.svc_issue_offers_auto(uuid, uuid, integer),
  public.get_offer_link(uuid), public.public_get_offer(text), public.public_respond_offer(text, text, text),
  public.svc_offer_token_material(uuid)
  to service_role;
