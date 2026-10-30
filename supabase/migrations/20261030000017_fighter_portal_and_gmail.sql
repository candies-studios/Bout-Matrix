-- 0017 — Fighter portal (log in with fighter ID + date of birth) and Gmail email sending.
--
-- Fighter portal: public_fighter_login returns a random session token (only its hash is stored, 12-hour expiry).
-- With it the fighter sees their own registrations, bout offers (and can accept / decline) and confirmed bouts.
-- Brute-force protection: 10 wrong passwords per fighter ID per hour lock that ID for the hour; 30 attempts
-- per 10 minutes per connection.
--
-- Email: the gmail-dispatch Edge Function (pasted into the Supabase dashboard) sends the queued emails through
-- Gmail. It reads its shared secret and the site address from svc_email_config(), and pg_cron calls it every
-- minute — so the only secrets you type anywhere are your Gmail address and App Password (Edge Function secrets).

-- ---------- fighter sessions ------------------------------------------------------------
create table if not exists public.fighter_sessions (
  token_hash  text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  fighter_id  uuid not null references public.fighters (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  ip_hash     text
);
create index if not exists fighter_sessions_fighter_idx on public.fighter_sessions (fighter_id);
alter table public.fighter_sessions enable row level security;   -- no policies: only the functions below touch it
revoke all on public.fighter_sessions from public, anon, authenticated;

create or replace function private.session_fighter(p_session text) returns uuid
language sql stable security definer set search_path = '' as $$
  select s.fighter_id from public.fighter_sessions s
    join public.fighters f on f.id = s.fighter_id and f.status = 'active'
   where p_session ~ '^[A-Za-z0-9_-]{43}$' and s.token_hash = private.sha256_hex(p_session) and s.expires_at > now()
$$;

create or replace function public.public_fighter_login(p_fighter_code text, p_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := private.request_ip_hash();
  v_code text := upper(trim(coalesce(p_fighter_code, '')));
  v_bucket text := 'fighter-login:' || upper(trim(coalesce(p_fighter_code, '')));
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / 3600) * 3600);
  f public.fighters;
  v_token text;
begin
  if v_ip is not null and not public.svc_rate_limit('fighter-login-ip:' || v_ip, 30, 600) then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;
  if coalesce((select hits from public.rate_limits where bucket = v_bucket and window_start = v_window), 0) >= 10 then
    return jsonb_build_object('ok', false, 'code', 'login_locked');
  end if;
  select fx.* into f from public.fighters fx join public.fighter_private fp on fp.fighter_id = fx.id
   where fx.fighter_code = v_code and fx.status = 'active'
     and private.dob_password(fp.date_of_birth) = regexp_replace(coalesce(p_password, ''), '\D', '', 'g');
  if not found then
    perform public.svc_rate_limit(v_bucket, 10, 3600);
    return jsonb_build_object('ok', false, 'code', 'login_failed');
  end if;
  v_token := private.b64url(extensions.gen_random_bytes(32));
  delete from public.fighter_sessions where expires_at < now();
  insert into public.fighter_sessions (token_hash, fighter_id, expires_at, ip_hash)
  values (private.sha256_hex(v_token), f.id, now() + interval '12 hours', v_ip);
  return jsonb_build_object('ok', true, 'session', v_token, 'expires_at', now() + interval '12 hours',
                            'fighter', jsonb_build_object('fight_name', f.fight_name, 'fighter_code', f.fighter_code));
end $$;

create or replace function public.public_fighter_logout(p_session text) returns void
language sql security definer set search_path = '' as $$
  delete from public.fighter_sessions where token_hash = private.sha256_hex(coalesce(p_session, ''))
$$;

-- Everything the fighter sees after logging in. Opening the portal counts as opening any pending offer.
create or replace function public.public_fighter_portal(p_session text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_fighter uuid := private.session_fighter(p_session);
  f public.fighters;
  v_offers jsonb := '[]'::jsonb;
  o record;
begin
  if v_fighter is null then return jsonb_build_object('ok', false, 'code', 'session_expired'); end if;
  select * into f from public.fighters where id = v_fighter;

  for o in
    select bo.id, bo.token_hash from public.bout_offers bo join public.bouts b on b.id = bo.bout_id
     where bo.fighter_id = v_fighter and bo.offer_version = b.offer_version and b.status <> 'cancelled'
       and (bo.status in ('pending', 'accepted', 'declined') or bo.created_at > now() - interval '14 days')
     order by (bo.status = 'pending' and bo.expires_at > now()) desc, bo.created_at desc
  loop
    v_offers := v_offers || (public.svc_get_offer(o.token_hash) - 'ok' || jsonb_build_object('offer_id', o.id));
  end loop;

  return jsonb_build_object(
    'ok', true,
    'fighter', jsonb_build_object('fight_name', f.fight_name, 'fighter_code', f.fighter_code,
                                  'gym', (select name from public.gyms where id = f.gym_id)),
    'offers', v_offers,
    'bouts', coalesce((select jsonb_agg(jsonb_build_object(
        'bout_code', b.bout_code, 'status', b.status, 'event_name', e.name, 'event_slug', e.slug,
        'starts_at', coalesce(b.proposed_starts_at, e.starts_at), 'timezone', e.timezone,
        'venue_name', e.venue_name, 'venue_city', e.venue_city,
        'weight_class', w.name, 'rounds', b.rounds, 'round_minutes', b.round_minutes,
        'opponent', (select fight_name from public.fighters where id = case when b.fighter_a_id = v_fighter then b.fighter_b_id else b.fighter_a_id end))
        order by e.starts_at nulls last)
      from public.bouts b join public.events e on e.id = b.event_id
      left join public.weight_classes w on w.id = b.weight_class_id
     where v_fighter in (b.fighter_a_id, b.fighter_b_id) and b.status in ('confirmed', 'completed')), '[]'::jsonb),
    'registrations', coalesce((select jsonb_agg(jsonb_build_object(
        'event_name', e.name, 'event_slug', e.slug, 'starts_at', e.starts_at, 'timezone', e.timezone,
        'status', er.status, 'division', er.division, 'weight_g', er.declared_weight_g,
        'missing_info', er.missing_info) order by er.created_at desc)
      from public.event_registrations er join public.events e on e.id = er.event_id
     where er.fighter_id = v_fighter), '[]'::jsonb));
end $$;

create or replace function public.public_fighter_respond(p_session text, p_offer uuid, p_response text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_fighter uuid := private.session_fighter(p_session);
  v_hash text;
begin
  if v_fighter is null then return jsonb_build_object('ok', false, 'code', 'session_expired'); end if;
  if p_response not in ('accept', 'decline') then return jsonb_build_object('ok', false, 'code', 'invalid'); end if;
  select token_hash into v_hash from public.bout_offers where id = p_offer and fighter_id = v_fighter;
  if v_hash is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  return public.svc_respond_offer(v_hash, p_response::public.offer_response, left(nullif(trim(p_reason), ''), 1000),
                                  private.request_ip_hash(), private.request_user_agent());
end $$;

-- ---------- Gmail dispatcher configuration ------------------------------------------------
insert into private.app_secrets (name, value)
values ('email_dispatch_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

create table if not exists private.app_settings (name text primary key, value text not null);
revoke all on private.app_settings from public, anon, authenticated;

create or replace function public.svc_email_config() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'dispatch_secret', (select value from private.app_secrets where name = 'email_dispatch_secret'),
    'site_url', (select value from private.app_settings where name = 'site_url'),
    'org_name', coalesce((select value from private.app_settings where name = 'org_name'),
                         (select name from public.organizations order by created_at limit 1), 'Fight Desk'))
$$;

-- ---------- grants -------------------------------------------------------------------------
revoke all on function private.session_fighter(text) from public, anon, authenticated;
grant execute on function private.session_fighter(text) to service_role;
revoke all on function public.public_fighter_login(text, text), public.public_fighter_logout(text),
  public.public_fighter_portal(text), public.public_fighter_respond(text, uuid, text, text), public.svc_email_config()
  from public, anon, authenticated;
grant execute on function public.public_fighter_login(text, text), public.public_fighter_logout(text),
  public.public_fighter_portal(text), public.public_fighter_respond(text, uuid, text, text)
  to anon, authenticated, service_role;
grant execute on function public.svc_email_config() to service_role;

-- Offer emails link to the fighter login page and show the fighter ID, so the dispatcher needs the code.
create or replace function public.svc_offer_token_material(p_offer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('offer_id', o.id, 'nonce', o.token_nonce, 'status',
                            case when o.status = 'pending' and o.expires_at <= now() then 'expired' else o.status::text end,
                            'expires_at', o.expires_at, 'token', private.offer_token(o.id, o.token_nonce),
                            'fighter_code', f.fighter_code)
    from public.bout_offers o join public.fighters f on f.id = o.fighter_id where o.id = p_offer
$$;
revoke all on function public.svc_offer_token_material(uuid) from public, anon, authenticated;
grant execute on function public.svc_offer_token_material(uuid) to service_role;
