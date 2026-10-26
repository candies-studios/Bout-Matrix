-- =====================================================================================
-- 0005 · Core functions: ID allocation, email outbox, bout & registration workflows,
--        public read API
-- =====================================================================================

-- ---------- identifiers ------------------------------------------------------------
-- Concurrency-safe: the upsert takes a row lock, so concurrent callers serialise.
-- Values are never decremented, so IDs are never reused (even after deletion/rollback gaps).
create or replace function private.next_code(p_org uuid, p_kind text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_n bigint;
  v_prefix text;
  v_letter text := case p_kind when 'fighter' then 'F' when 'bout' then 'B' when 'event' then 'E' end;
  v_width int := case p_kind when 'event' then 3 else 4 end;
begin
  if v_letter is null then raise exception 'unknown code kind %', p_kind; end if;
  select o.fighter_id_prefix into v_prefix from public.organizations o where o.id = p_org;
  if v_prefix is null then raise exception 'organisation % not found', p_org; end if;

  insert into public.id_counters as c (org_id, kind, last_value) values (p_org, p_kind, 1)
  on conflict (org_id, kind) do update set last_value = c.last_value + 1
  returning c.last_value into v_n;

  return v_prefix || '-' || v_letter || '-' ||
         case when length(v_n::text) < v_width then lpad(v_n::text, v_width, '0') else v_n::text end;
end $$;

-- Assign codes automatically if a caller did not.
create or replace function private.assign_code() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Nested IFs: PL/pgSQL does not short-circuit, and NEW lacks the other tables' columns.
  if tg_table_name = 'fighters' then
    if new.fighter_code is null then new.fighter_code := private.next_code(new.org_id, 'fighter'); end if;
  elsif tg_table_name = 'bouts' then
    if new.bout_code is null then new.bout_code := private.next_code(new.org_id, 'bout'); end if;
  elsif tg_table_name = 'events' then
    if new.event_code is null then new.event_code := private.next_code(new.org_id, 'event'); end if;
  end if;
  return new;
end $$;
create trigger assign_code before insert on public.fighters for each row execute function private.assign_code();
create trigger assign_code before insert on public.bouts for each row execute function private.assign_code();
create trigger assign_code before insert on public.events for each row execute function private.assign_code();

-- Codes are permanent.
create or replace function private.codes_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'fighters' then
    if new.fighter_code <> old.fighter_code then
      raise exception 'permanent identifiers cannot be changed' using errcode = 'check_violation';
    end if;
  elsif new.event_code <> old.event_code then
    raise exception 'permanent identifiers cannot be changed' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger codes_immutable before update on public.fighters for each row execute function private.codes_immutable();
create trigger codes_immutable before update on public.events for each row execute function private.codes_immutable();

-- Fighters are never hard-deleted (IDs, bouts and audit history reference them).
create trigger fighters_no_delete before delete on public.fighters for each row execute function private.reject_mutation();

-- ---------- request context --------------------------------------------------------
create or replace function private.set_context(p_actor uuid, p_kind text, p_reason text) returns void
language plpgsql set search_path = '' as $$
begin
  perform set_config('app.actor_id', coalesce(p_actor::text, ''), true);
  perform set_config('app.actor_kind', p_kind, true);
  perform set_config('app.reason', coalesce(p_reason, ''), true);
end $$;

-- ---------- email outbox -----------------------------------------------------------
create or replace function private.enqueue_email(
  p_org uuid, p_event uuid, p_template text, p_to text, p_to_name text, p_payload jsonb,
  p_idempotency_key text, p_entity_type text, p_entity_id uuid, p_category text default 'transactional'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_to is null or p_to = '' then return null; end if;
  if p_category <> 'transactional' and exists (
       select 1 from public.notification_preferences np
        where np.org_id = p_org and np.email = lower(p_to) and np.category = p_category and not np.enabled) then
    return null;
  end if;
  insert into public.email_logs (org_id, event_id, template, to_email, to_name, payload, idempotency_key,
                                 entity_type, entity_id, created_by)
  values (p_org, p_event, p_template, lower(p_to), p_to_name, coalesce(p_payload, '{}'::jsonb),
          p_idempotency_key, p_entity_type, p_entity_id, auth.uid())
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- Recipients for admin notifications about an event: event admins, falling back to org admins.
create or replace function private.event_admin_recipients(p_event uuid)
returns table (user_id uuid, email text, full_name text)
language sql stable security definer set search_path = '' as $$
  with ea as (
    select up.id, up.email, up.full_name from public.event_admins a
      join public.user_profiles up on up.id = a.user_id
     where a.event_id = p_event and a.role = 'event_admin' and up.email is not null),
  oa as (
    select up.id, up.email, up.full_name from public.events e
      join public.user_roles r on r.org_id = e.org_id and r.role = 'org_admin'
      join public.user_profiles up on up.id = r.user_id
     where e.id = p_event and up.email is not null)
  select * from ea
  union all
  select * from oa where not exists (select 1 from ea)
$$;

-- Notify both fighters (and, if enabled, their approved coaches) about a bout event.
create or replace function private.notify_bout_parties(p_bout uuid, p_template text, p_extra jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b record; r record;
  v_event record;
begin
  select * into b from public.bouts where id = p_bout;
  select * into v_event from public.events where id = b.event_id;
  for r in
    select f.id as fighter_id, f.fight_name, fp.email, fp.legal_name,
           case when f.id = b.fighter_a_id then b.fighter_b_id else b.fighter_a_id end as opponent_id
      from public.fighters f join public.fighter_private fp on fp.fighter_id = f.id
     where f.id in (b.fighter_a_id, b.fighter_b_id)
  loop
    perform private.enqueue_email(
      b.org_id, b.event_id, p_template, r.email, r.legal_name,
      jsonb_build_object('bout_id', b.id, 'bout_code', b.bout_code, 'event_name', v_event.name,
                         'event_slug', v_event.slug, 'fighter_name', r.fight_name,
                         'opponent_name', (select fight_name from public.fighters where id = r.opponent_id)) || p_extra,
      format('%s:%s:v%s:%s:%s', p_template, b.id, b.offer_version, r.fighter_id,
             coalesce(p_extra ->> 'dedupe', to_char(now(), 'YYYYMMDDHH24MISSMS'))),
      'bout', b.id);
    if v_event.notify_coaches then
      perform private.enqueue_email(
        b.org_id, b.event_id, p_template || '_coach', c.email, c.full_name,
        jsonb_build_object('bout_id', b.id, 'bout_code', b.bout_code, 'event_name', v_event.name,
                           'fighter_name', r.fight_name) || p_extra,
        format('%s_coach:%s:v%s:%s:%s:%s', p_template, b.id, b.offer_version, r.fighter_id, c.id,
               coalesce(p_extra ->> 'dedupe', to_char(now(), 'YYYYMMDDHH24MISSMS'))),
        'bout', b.id, 'coach_updates')
      from public.coach_fighters cf join public.coaches c on c.id = cf.coach_id
     where cf.fighter_id = r.fighter_id and cf.status = 'approved' and c.verification_status = 'verified';
    end if;
  end loop;
end $$;

-- ---------- bout workflow RPCs (called with the user's JWT) --------------------------
create or replace function public.transition_bout(
  p_bout uuid, p_to public.bout_status, p_reason text default null, p_expected_updated_at timestamptz default null
) returns public.bouts
language plpgsql security definer set search_path = '' as $$
declare
  b public.bouts;
  v_uid uuid := auth.uid();
begin
  select * into b from public.bouts where id = p_bout for update;
  if not found or not private.can_matchmake_event(b.event_id, v_uid) then
    raise exception 'bout not found' using errcode = 'no_data_found';
  end if;
  if p_to in ('confirmed', 'cancelled', 'completed') and not private.can_manage_event(b.event_id, v_uid) then
    raise exception 'only event administrators can % a bout', p_to using errcode = 'insufficient_privilege';
  end if;
  if p_to not in ('under_review', 'draft', 'confirmed', 'cancelled', 'completed') then
    raise exception 'status % is set by the offer workflow, not manually', p_to using errcode = 'check_violation';
  end if;
  if p_expected_updated_at is not null and b.updated_at <> p_expected_updated_at then
    raise exception 'bout was modified by someone else; reload and try again' using errcode = 'serialization_failure';
  end if;

  perform private.set_context(v_uid, 'user', nullif(trim(p_reason), ''));
  update public.bouts set status = p_to where id = p_bout returning * into b;

  if p_to = 'confirmed' then
    perform private.notify_bout_parties(b.id, 'bout_confirmed', jsonb_build_object('dedupe', 'once'));
  elsif p_to = 'cancelled' then
    perform private.notify_bout_parties(b.id, 'bout_cancelled', jsonb_build_object('dedupe', 'once', 'reason', p_reason));
    update public.bout_offers set status = 'withdrawn', revoked_at = now(), revoked_reason = 'bout cancelled'
     where bout_id = b.id and status = 'pending';
  elsif p_to = 'under_review' then
    -- Pending offers can no longer be answered while the bout is being reviewed.
    update public.bout_offers set status = 'revoked', revoked_at = now(), revoked_reason = 'bout under review'
     where bout_id = b.id and status = 'pending';
  end if;
  return b;
end $$;

create or replace function public.set_bout_published(p_bout uuid, p_published boolean, p_reason text default null)
returns public.bouts
language plpgsql security definer set search_path = '' as $$
declare b public.bouts; v_uid uuid := auth.uid();
begin
  select * into b from public.bouts where id = p_bout for update;
  if not found or not private.can_manage_event(b.event_id, v_uid) then
    raise exception 'bout not found' using errcode = 'no_data_found';
  end if;
  if p_published and b.status not in ('confirmed', 'completed') then
    raise exception 'only confirmed bouts can be published' using errcode = 'check_violation';
  end if;
  perform private.set_context(v_uid, 'user', p_reason);
  update public.bouts set is_published = p_published where id = p_bout returning * into b;
  return b;
end $$;

create or replace function public.set_fight_card_published(p_event uuid, p_published boolean, p_reason text default null)
returns public.events
language plpgsql security definer set search_path = '' as $$
declare e public.events; v_uid uuid := auth.uid();
begin
  select * into e from public.events where id = p_event for update;
  if not found or not private.can_manage_event(p_event, v_uid) then
    raise exception 'event not found' using errcode = 'no_data_found';
  end if;
  if p_published and not e.is_public then
    raise exception 'make the event public before publishing its fight card' using errcode = 'check_violation';
  end if;
  perform private.set_context(v_uid, 'user', p_reason);
  update public.events set fight_card_published = p_published where id = p_event returning * into e;
  return e;
end $$;

-- ---------- registration review ----------------------------------------------------
create or replace function public.review_registration(
  p_registration uuid, p_status public.registration_status, p_reason text default null,
  p_missing_info jsonb default null
) returns public.event_registrations
language plpgsql security definer set search_path = '' as $$
declare
  r public.event_registrations;
  v_uid uuid := auth.uid();
  v_ok boolean;
  v_fp record; v_event record; v_f record;
begin
  select * into r from public.event_registrations where id = p_registration for update;
  if not found or not private.can_manage_event(r.event_id, v_uid) then
    raise exception 'registration not found' using errcode = 'no_data_found';
  end if;

  v_ok := case r.status
    when 'submitted'    then p_status in ('under_review', 'approved', 'rejected', 'incomplete')
    when 'under_review' then p_status in ('approved', 'rejected', 'incomplete')
    when 'incomplete'   then p_status in ('under_review', 'rejected')
    when 'approved'     then p_status in ('under_review')
    when 'rejected'     then p_status in ('under_review')
    else false end;
  if not v_ok then
    raise exception 'invalid registration status transition % → %', r.status, p_status using errcode = 'check_violation';
  end if;
  if p_status in ('rejected', 'incomplete') and nullif(trim(p_reason), '') is null then
    raise exception 'a reason is required' using errcode = 'check_violation';
  end if;
  if r.status in ('approved', 'rejected') and nullif(trim(p_reason), '') is null then
    raise exception 'a reason is required to reopen a decided registration' using errcode = 'check_violation';
  end if;
  if p_status = 'incomplete' and (p_missing_info is null or jsonb_typeof(p_missing_info) <> 'array'
                                  or jsonb_array_length(p_missing_info) = 0) then
    raise exception 'list the missing information' using errcode = 'check_violation';
  end if;

  perform private.set_context(v_uid, 'user', p_reason);
  update public.event_registrations
     set status = p_status, reviewed_by = v_uid, reviewed_at = now(),
         rejection_reason = case when p_status = 'rejected' then p_reason else null end,
         missing_info = case when p_status = 'incomplete' then p_missing_info else '[]'::jsonb end
   where id = p_registration returning * into r;

  if p_status in ('approved', 'rejected', 'incomplete') then
    select * into v_fp from public.fighter_private where fighter_id = r.fighter_id;
    select * into v_f from public.fighters where id = r.fighter_id;
    select * into v_event from public.events where id = r.event_id;
    perform private.enqueue_email(
      v_event.org_id, r.event_id, 'registration_' || p_status::text, v_fp.email, v_fp.legal_name,
      jsonb_build_object('fighter_name', v_f.fight_name, 'fighter_code', v_f.fighter_code,
                         'event_name', v_event.name, 'event_slug', v_event.slug,
                         'reason', case when p_status <> 'approved' then p_reason end,
                         'missing_info', case when p_status = 'incomplete' then p_missing_info end),
      format('registration_%s:%s:%s', p_status, r.id, to_char(now(), 'YYYYMMDDHH24MISSMS')),
      'registration', r.id);
  end if;
  return r;
end $$;

-- ---------- public read API (anon) -------------------------------------------------
-- Only whitelisted columns of explicitly public data. Unpublished data is unreachable.
create or replace function private.public_fighter_json(p_fighter uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'fight_name', f.fight_name,
    'nickname', f.nickname,
    'country', f.country,
    'hometown', case when f.public_profile_approved then f.hometown end,
    'bio', case when f.public_profile_approved then f.bio end,
    'photo_path', case when f.public_profile_approved then f.public_photo_path end,
    'height_cm', case when f.public_profile_approved then f.height_cm end,
    'reach_cm', case when f.public_profile_approved then f.reach_cm end,
    'primary_style', f.primary_style,
    'gym', (select g.name from public.gyms g
             where g.id = f.gym_id and g.is_public and g.verification_status = 'verified'),
    'record', (select jsonb_build_object('wins', r.wins, 'losses', r.losses, 'draws', r.draws,
                                         'no_contests', r.no_contests, 'ko_tko_wins', r.ko_tko_wins,
                                         'submission_wins', r.submission_wins, 'decision_wins', r.decision_wins)
                 from public.fighter_records r where r.fighter_id = f.id and r.kind = 'verified'))
  from public.fighters f where f.id = p_fighter
$$;

create or replace function public.public_list_events(p_scope text default 'all')
returns table (slug text, name text, promotion text, description text, branding jsonb, starts_at timestamptz,
               timezone text, venue_name text, venue_city text, venue_country text, status public.event_status,
               registration_open boolean, fight_card_published boolean)
language sql stable security definer set search_path = '' as $$
  select e.slug, e.name, e.promotion, e.description, e.branding, e.starts_at, e.timezone,
         e.venue_name, e.venue_city, e.venue_country, e.status,
         (e.status = 'registration_open'
           and (e.registration_opens_at is null or e.registration_opens_at <= now())
           and (e.registration_closes_at is null or e.registration_closes_at > now())) as registration_open,
         e.fight_card_published
    from public.events e
   where e.is_public and e.status <> 'draft'
     and case p_scope
           when 'upcoming' then e.status not in ('completed', 'cancelled')
                                and (e.starts_at is null or e.starts_at >= now() - interval '1 day')
           when 'past' then e.status = 'completed' or e.starts_at < now() - interval '1 day'
           else true end
   order by e.starts_at nulls last, e.name
$$;

create or replace function public.public_get_event(p_slug text)
returns table (slug text, name text, promotion text, description text, branding jsonb, starts_at timestamptz,
               timezone text, venue_name text, venue_address text, venue_city text, venue_country text,
               status public.event_status, registration_open boolean, registration_closes_at timestamptz,
               fight_card_published boolean, rules_text text, weight_classes jsonb)
language sql stable security definer set search_path = '' as $$
  select e.slug, e.name, e.promotion, e.description, e.branding, e.starts_at, e.timezone,
         e.venue_name, e.venue_address, e.venue_city, e.venue_country, e.status,
         (e.status = 'registration_open'
           and (e.registration_opens_at is null or e.registration_opens_at <= now())
           and (e.registration_closes_at is null or e.registration_closes_at > now())),
         e.registration_closes_at, e.fight_card_published, e.rules_text,
         coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'division', w.division,
                                                       'min_g', w.min_g, 'max_g', w.max_g)
                                    order by w.division nulls first, w.sort_order, w.max_g)
                     from public.weight_classes w where w.event_id = e.id and w.is_active), '[]'::jsonb)
    from public.events e
   where e.slug = p_slug and e.is_public and e.status <> 'draft'
$$;

-- Registration forms need the event even before it is announced publicly (shareable link).
create or replace function public.public_registration_event(p_slug text)
returns table (slug text, name text, starts_at timestamptz, venue_name text, venue_city text,
               registration_open boolean, registration_closes_at timestamptz, divisions jsonb,
               competition_levels jsonb, required_documents jsonb, weight_classes jsonb)
language sql stable security definer set search_path = '' as $$
  select e.slug, e.name, e.starts_at, e.venue_name, e.venue_city,
         (e.status = 'registration_open'
           and (e.registration_opens_at is null or e.registration_opens_at <= now())
           and (e.registration_closes_at is null or e.registration_closes_at > now())),
         e.registration_closes_at,
         coalesce(e.eligibility -> 'divisions', '[]'::jsonb),
         coalesce(e.eligibility -> 'competition_levels', '[]'::jsonb),
         coalesce(e.eligibility -> 'required_documents', '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'division', w.division,
                                                       'min_g', w.min_g, 'max_g', w.max_g)
                                    order by w.division nulls first, w.sort_order, w.max_g)
                     from public.weight_classes w where w.event_id = e.id and w.is_active), '[]'::jsonb)
    from public.events e
   where e.slug = p_slug and e.status in ('registration_open', 'registration_closed', 'matchmaking',
                                          'fight_card_pending', 'published')
$$;

create or replace function public.public_get_fight_card(p_slug text)
returns table (bout_code text, card_order smallint, card_segment text, weight_class text, weight_limit_g integer,
               division text, rounds smallint, round_minutes smallint, status public.bout_status,
               fighter_a jsonb, fighter_b jsonb)
language sql stable security definer set search_path = '' as $$
  select b.bout_code, b.card_order, b.card_segment, w.name, w.max_g, w.division, b.rounds, b.round_minutes,
         b.status, private.public_fighter_json(b.fighter_a_id), private.public_fighter_json(b.fighter_b_id)
    from public.bouts b
    join public.events e on e.id = b.event_id
    left join public.weight_classes w on w.id = b.weight_class_id
   where e.slug = p_slug and e.is_public and e.fight_card_published
     and b.is_published and b.status in ('confirmed', 'completed')
   order by b.card_order nulls last, b.created_at
$$;

create or replace function public.public_list_gyms()
returns table (id uuid, name text, city text, country text)
language sql stable security definer set search_path = '' as $$
  select g.id, g.name, g.city, g.country from public.gyms g
   where g.is_public and g.verification_status = 'verified' order by g.name
$$;

-- ---------- session access summary (UI uses it to decide what to show; the DB still enforces) ----
create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'user_id', auth.uid(),
    'is_super_admin', private.is_super_admin(),
    'org_roles', coalesce((select jsonb_agg(jsonb_build_object('org_id', r.org_id, 'role', r.role))
                             from public.user_roles r where r.user_id = auth.uid()), '[]'::jsonb),
    'event_roles', coalesce((select jsonb_agg(jsonb_build_object('event_id', ea.event_id, 'role', ea.role))
                               from public.event_admins ea where ea.user_id = auth.uid()
                                and private.is_org_staff((select e.org_id from public.events e where e.id = ea.event_id))),
                            '[]'::jsonb),
    'coach_id', private.current_coach_id())
  end
$$;

-- ---------- function privileges ----------------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
-- authenticated only needs the read-only predicates used inside RLS policies.
grant execute on function private.is_super_admin(uuid), private.has_org_role(uuid, public.app_role[], uuid),
                          private.is_org_admin(uuid, uuid), private.is_org_staff(uuid, uuid),
                          private.can_manage_event(uuid, uuid), private.can_matchmake_event(uuid, uuid),
                          private.current_coach_id(uuid), private.coach_can_access_fighter(uuid, uuid),
                          private.can_view_fighter(uuid, uuid), private.can_edit_fighter(uuid, uuid),
                          private.can_view_bout(uuid, uuid)
  to authenticated;
grant execute on function public.public_list_events(text), public.public_get_event(text),
                          public.public_registration_event(text), public.public_get_fight_card(text),
                          public.public_list_gyms()
  to anon, authenticated;
grant execute on function public.transition_bout(uuid, public.bout_status, text, timestamptz),
                          public.set_bout_published(uuid, boolean, text),
                          public.set_fight_card_published(uuid, boolean, text),
                          public.review_registration(uuid, public.registration_status, text, jsonb),
                          public.my_access()
  to authenticated;
grant execute on all functions in schema public to service_role;
