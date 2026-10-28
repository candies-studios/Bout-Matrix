-- 0015 — (1) Offer pages require the fighter to log in; (2) public fighter registration without Edge Functions.
--
-- (1) Offer login. The personal offer link is still required, and the page now also asks for
--     login ID = fighter ID (e.g. WDS-F-0012) and password = date of birth as DDMMYYYY (10 March 1987 → 10031987).
--     Nothing about the offer is returned until both match the fighter the link was issued to.
--     After 10 wrong attempts a link is locked for an hour (and per-IP limits still apply).
-- (2) Registration. Uploads go straight into the private bucket (anonymous users may only CREATE files under
--     pending/<random id>/, never read, list or overwrite them; rate limited per IP), and the form is saved by
--     public.public_register_fighter, which runs the same checks as the Edge Function did.

-- ---------- (1) offer login -----------------------------------------------------------------
create or replace function private.dob_password(p_dob date) returns text
language sql immutable set search_path = '' as $$ select to_char(p_dob, 'DDMMYYYY') $$;

-- Returns null when the credentials match the offer's fighter, otherwise an error code.
create or replace function private.check_offer_login(p_token_hash text, p_fighter_code text, p_password text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
  v_bucket text := 'offer-login:' || p_token_hash;
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / 3600) * 3600);
begin
  if not exists (select 1 from public.bout_offers where token_hash = p_token_hash) then return 'not_found'; end if;
  if coalesce((select hits from public.rate_limits where bucket = v_bucket and window_start = v_window), 0) >= 10 then
    return 'login_locked';
  end if;
  if nullif(trim(p_fighter_code), '') is null or nullif(p_password, '') is null then return 'login_required'; end if;
  select exists (
    select 1 from public.bout_offers o
      join public.fighters f on f.id = o.fighter_id
      join public.fighter_private fp on fp.fighter_id = f.id
     where o.token_hash = p_token_hash
       and f.fighter_code = upper(trim(p_fighter_code))
       and private.dob_password(fp.date_of_birth) = regexp_replace(p_password, '\D', '', 'g'))
    into v_ok;
  if v_ok then return null; end if;
  perform public.svc_rate_limit(v_bucket, 10, 3600);   -- count the failure
  return 'login_failed';
end $$;

drop function if exists public.public_get_offer(text);
drop function if exists public.public_respond_offer(text, text, text);

create or replace function public.public_get_offer(p_token text, p_fighter_code text default null, p_password text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ip text := private.request_ip_hash(); v_err text;
begin
  if v_ip is not null and not public.svc_rate_limit('offer-view:' || v_ip, 60, 600) then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  v_err := private.check_offer_login(private.sha256_hex(p_token), p_fighter_code, p_password);
  if v_err is not null then return jsonb_build_object('ok', false, 'code', v_err); end if;
  return public.svc_get_offer(private.sha256_hex(p_token));
end $$;

create or replace function public.public_respond_offer(p_token text, p_response text, p_reason text default null,
                                                       p_fighter_code text default null, p_password text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ip text := private.request_ip_hash(); v_err text;
begin
  if v_ip is not null and not public.svc_rate_limit('offer-respond:' || v_ip, 20, 600) then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  v_err := private.check_offer_login(private.sha256_hex(p_token), p_fighter_code, p_password);
  if v_err is not null then return jsonb_build_object('ok', false, 'code', v_err); end if;
  if p_response not in ('accept', 'decline') then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;
  return public.svc_respond_offer(private.sha256_hex(p_token), p_response::public.offer_response,
                                  left(nullif(trim(p_reason), ''), 1000), v_ip, private.request_user_agent());
end $$;

-- ---------- (2) registration ---------------------------------------------------------------
-- True if an uploaded file exists in the private bucket (always true on plain Postgres without Supabase storage).
create or replace function private.registration_file_exists(p_path text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v boolean;
begin
  if to_regclass('storage.objects') is null then return true; end if;
  execute 'select exists (select 1 from storage.objects where bucket_id = ''registration-private'' and name = $1)'
    into v using p_path;
  return v;
end $$;

-- Upload rate limit used by the storage policy below (anonymous visitors: 20 files per hour per IP).
create or replace function public.registration_upload_allowed() returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_ip text := private.request_ip_hash();
begin
  return v_ip is null or public.svc_rate_limit('upload:' || v_ip, 20, 3600);
end $$;

create or replace function public.public_register_fighter(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := private.request_ip_hash();
  v_uid uuid := auth.uid();
  v_coach uuid;
  v_kg numeric;
  v_doc jsonb;
  v_path_re constant text := '^pending/[0-9a-f-]{36}/[a-z_]{2,40}\.(jpg|png|webp|pdf)$';
  r jsonb;
begin
  if v_ip is not null and not public.svc_rate_limit('register-fighter:' || v_ip, 10, 3600) then
    perform private.raise_app('rate_limited', 'Too many registrations from this connection. Please wait an hour and try again.');
  end if;
  if coalesce(p ->> 'website', '') <> '' then perform private.raise_app('invalid', 'Registration could not be accepted.'); end if; -- honeypot
  if coalesce((p ->> 'consent_data')::boolean, false) is not true or coalesce((p ->> 'consent_rules')::boolean, false) is not true then
    perform private.raise_app('invalid', 'You must agree to the data-processing statement and the declaration.');
  end if;
  if nullif(trim(p ->> 'legal_name'), '') is null or nullif(trim(p ->> 'fight_name'), '') is null
     or nullif(p ->> 'date_of_birth', '') is null or nullif(trim(p ->> 'email'), '') is null
     or nullif(p ->> 'division', '') is null then
    perform private.raise_app('invalid', 'Please fill in all required fields.');
  end if;
  if (p ->> 'date_of_birth')::date > current_date - interval '8 years' or (p ->> 'date_of_birth')::date < date '1930-01-01' then
    perform private.raise_app('invalid', 'Please check the date of birth.');
  end if;
  v_kg := nullif(p ->> 'weight_value', '')::numeric;
  if v_kg is null or v_kg < 25 or v_kg > 180 then
    perform private.raise_app('invalid', 'Weight must be between 25 and 180 kg.');
  end if;
  if nullif(p ->> 'photo_path', '') is not null and (p ->> 'photo_path' !~ v_path_re or not private.registration_file_exists(p ->> 'photo_path')) then
    perform private.raise_app('upload_missing', 'The uploaded photo could not be found. Please attach it again.');
  end if;
  for v_doc in select * from jsonb_array_elements(coalesce(p -> 'documents', '[]'::jsonb)) loop
    if v_doc ->> 'path' !~ v_path_re or not private.registration_file_exists(v_doc ->> 'path') then
      perform private.raise_app('upload_missing', 'An uploaded document could not be found. Please attach it again.');
    end if;
  end loop;

  if v_uid is not null then
    select id into v_coach from public.coaches where user_id = v_uid and verification_status = 'verified';
  end if;

  r := public.svc_register_fighter(
         (p - 'website' - 'consent_data' - 'consent_rules' - 'weight_value' - 'captcha_token')
           || jsonb_build_object('weight_g', round(v_kg * 1000)::int, 'weight_unit', 'kg', 'consent_version', 'v1'),
         v_uid, v_coach);
  return jsonb_build_object('status', r ->> 'status', 'fighter_code', r ->> 'fighter_code',
                            'event_name', r ->> 'event_name', 'registration_status', r ->> 'registration_status');
end $$;

-- Anonymous uploads into the private bucket: create-only, fixed path shape, rate limited. Nobody but staff can read them.
do $outer$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "registration uploads" on storage.objects';
    execute $p$
      create policy "registration uploads" on storage.objects for insert to anon, authenticated
      with check (bucket_id = 'registration-private'
                  and name ~ '^pending/[0-9a-f-]{36}/[a-z_]{2,40}\.(jpg|png|webp|pdf)$'
                  and public.registration_upload_allowed())
    $p$;
  end if;
end
$outer$;

-- ---------- grants -------------------------------------------------------------------------
revoke all on function private.dob_password(date), private.check_offer_login(text, text, text),
  private.registration_file_exists(text) from public, anon, authenticated;
grant execute on function private.dob_password(date), private.check_offer_login(text, text, text),
  private.registration_file_exists(text) to service_role;
-- The storage policy runs as the uploader, so this helper lives in public (it only counts the caller's own uploads).
revoke all on function public.registration_upload_allowed() from public;
grant execute on function public.registration_upload_allowed() to anon, authenticated, service_role;

revoke all on function public.public_get_offer(text, text, text), public.public_respond_offer(text, text, text, text, text),
  public.public_register_fighter(jsonb) from public, anon, authenticated;
grant execute on function public.public_get_offer(text, text, text), public.public_respond_offer(text, text, text, text, text),
  public.public_register_fighter(jsonb) to anon, authenticated, service_role;
