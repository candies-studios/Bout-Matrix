-- =====================================================================================
-- 0006 · Workflows: registration, events, bouts, offers, email dispatch, rate limiting,
--        admin RPCs. Functions prefixed `svc_` are callable ONLY by the service role
--        (Edge Functions), which must verify the caller before passing p_actor.
-- =====================================================================================

-- ---------- helpers ----------------------------------------------------------------
create or replace function private.event_registration_open(e public.events) returns boolean
language sql stable set search_path = '' as $$
  select e.status = 'registration_open'
     and (e.registration_opens_at is null or e.registration_opens_at <= now())
     and (e.registration_closes_at is null or e.registration_closes_at > now())
$$;

create or replace function private.raise_app(p_code text, p_message text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%', p_message using errcode = 'P0001', hint = p_code;
end $$;

-- Gym lookup-or-create (pending verification) for public forms.
create or replace function private.resolve_gym(p_org uuid, p_gym_id uuid, p_gym_name text, p_city text, p_country text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_gym_id is not null then
    select id into v_id from public.gyms where id = p_gym_id and org_id = p_org;
    if v_id is not null then return v_id; end if;
  end if;
  if nullif(trim(p_gym_name), '') is null then return null; end if;
  select id into v_id from public.gyms
   where org_id = p_org and lower(name) = lower(trim(p_gym_name))
     and lower(coalesce(city, '')) = lower(coalesce(trim(p_city), ''));
  if v_id is null then
    insert into public.gyms (org_id, name, city, country)
    values (p_org, trim(p_gym_name), nullif(trim(p_city), ''), nullif(trim(p_country), ''))
    on conflict do nothing returning id into v_id;
    if v_id is null then
      select id into v_id from public.gyms
       where org_id = p_org and lower(name) = lower(trim(p_gym_name))
         and lower(coalesce(city, '')) = lower(coalesce(trim(p_city), ''));
    end if;
  end if;
  return v_id;
end $$;

-- ---------- fighter registration ---------------------------------------------------
create or replace function public.svc_register_fighter(p jsonb, p_actor uuid default null, p_coach uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key uuid := (p ->> 'submission_key')::uuid;
  v_prev jsonb;
  v_org uuid;
  v_event public.events;
  v_fighter public.fighters;
  v_reused boolean := false;
  v_reg_id uuid;
  v_email text := lower(trim(p ->> 'email'));
  v_dob date := (p ->> 'date_of_birth')::date;
  v_gym uuid;
  v_result jsonb;
  v_late boolean := false;
  v_weight int := nullif(p ->> 'weight_g', '')::int;
  v_doc jsonb;
  v_existing_reg public.event_registrations;
  v_coach public.coaches;
  v_divisions jsonb;
begin
  if v_key is null then perform private.raise_app('invalid', 'submission_key is required'); end if;

  -- Idempotency: replay the stored result for repeated submissions.
  select result into v_prev from public.registration_submissions where submission_key = v_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  if nullif(p ->> 'event_slug', '') is not null then
    select * into v_event from public.events where slug = p ->> 'event_slug';
    if not found or v_event.status in ('draft', 'cancelled', 'completed') then
      perform private.raise_app('event_not_found', 'This event is not accepting registrations.');
    end if;
    v_org := v_event.org_id;
    if not private.event_registration_open(v_event) then
      if v_event.allow_late_registration
         or (p_actor is not null and private.can_manage_event(v_event.id, p_actor)) then
        v_late := true;
      else
        perform private.raise_app('registration_closed', 'Registration for this event is closed.');
      end if;
    end if;
    v_divisions := v_event.eligibility -> 'divisions';
    if v_divisions is not null and jsonb_typeof(v_divisions) = 'array' and jsonb_array_length(v_divisions) > 0
       and not v_divisions ? (p ->> 'division') then
      perform private.raise_app('division_not_allowed', 'That division is not offered at this event.');
    end if;
    if nullif(p ->> 'preferred_weight_class_id', '') is not null and not exists (
         select 1 from public.weight_classes w
          where w.id = (p ->> 'preferred_weight_class_id')::uuid and w.event_id = v_event.id) then
      perform private.raise_app('invalid', 'Unknown weight class for this event.');
    end if;
  else
    select id into v_org from public.organizations order by created_at limit 1;
  end if;

  if p_coach is not null then
    select * into v_coach from public.coaches where id = p_coach and verification_status = 'verified' and org_id = v_org;
    if not found then perform private.raise_app('forbidden', 'Coach account is not verified.'); end if;
  end if;

  perform private.set_context(p_actor, case when p_actor is null then 'system' else 'user' end, 'registration');

  -- Identity reuse: requires fighter ID + email + date of birth to all match.
  if nullif(p ->> 'existing_fighter_code', '') is not null then
    select f.* into v_fighter from public.fighters f
      join public.fighter_private fp on fp.fighter_id = f.id
     where f.org_id = v_org and f.fighter_code = upper(trim(p ->> 'existing_fighter_code'))
       and fp.email = v_email and fp.date_of_birth = v_dob and f.status = 'active';
    if not found then
      perform private.raise_app('identity_mismatch',
        'We could not match that fighter ID with the email and date of birth provided.');
    end if;
    v_reused := true;
  else
    v_gym := private.resolve_gym(v_org, nullif(p ->> 'gym_id', '')::uuid, p ->> 'gym_name', p ->> 'city', p ->> 'country');
    insert into public.fighters (org_id, fight_name, nickname, gym_id, division, competition_level, primary_style,
                                 skill_level, height_cm, reach_cm, hometown, country, photo_path)
    values (v_org, trim(p ->> 'fight_name'), nullif(trim(p ->> 'nickname'), ''), v_gym, p ->> 'division',
            coalesce(p ->> 'competition_level', 'amateur')::public.competition_level,
            nullif(trim(p ->> 'primary_style'), ''), nullif(p ->> 'skill_level', '')::public.skill_level,
            nullif(p ->> 'height_cm', '')::numeric, nullif(p ->> 'reach_cm', '')::numeric,
            nullif(trim(p ->> 'city'), ''), nullif(trim(p ->> 'country'), ''), nullif(p ->> 'photo_path', ''))
    returning * into v_fighter;

    insert into public.fighter_private (fighter_id, legal_name, date_of_birth, email, phone_country_code, phone, city,
                                        country, mma_experience_years, previous_experience, coach_name_declared,
                                        consent_at, consent_version)
    values (v_fighter.id, trim(p ->> 'legal_name'), v_dob, v_email, nullif(p ->> 'phone_country_code', ''),
            nullif(p ->> 'phone', ''), nullif(trim(p ->> 'city'), ''), nullif(trim(p ->> 'country'), ''),
            nullif(p ->> 'mma_experience_years', '')::numeric, nullif(p ->> 'previous_experience', ''),
            nullif(trim(p ->> 'coach_name'), ''), now(), coalesce(p ->> 'consent_version', 'v1'));

    insert into public.fighter_records (fighter_id, kind, wins, losses, draws, no_contests, ko_tko_wins,
                                        submission_wins, decision_wins, source_note)
    values (v_fighter.id, 'self_reported', coalesce((p ->> 'wins')::smallint, 0), coalesce((p ->> 'losses')::smallint, 0),
            coalesce((p ->> 'draws')::smallint, 0), coalesce((p ->> 'no_contests')::smallint, 0),
            nullif(p ->> 'ko_tko_wins', '')::smallint, nullif(p ->> 'submission_wins', '')::smallint,
            nullif(p ->> 'decision_wins', '')::smallint, 'Declared at registration');

    -- Possible duplicates for admin review (never auto-merged).
    insert into public.fighter_duplicate_flags (fighter_id, candidate_fighter_id, match_reason)
    select v_fighter.id, fp.fighter_id,
           case when fp.email = v_email then 'same email' else 'same legal name and date of birth' end
      from public.fighter_private fp join public.fighters f on f.id = fp.fighter_id
     where fp.fighter_id <> v_fighter.id and f.org_id = v_org and f.status <> 'merged'
       and (fp.email = v_email or (lower(fp.legal_name) = lower(trim(p ->> 'legal_name')) and fp.date_of_birth = v_dob))
    on conflict do nothing;
  end if;

  if p_coach is not null then
    insert into public.coach_fighters (coach_id, fighter_id, status, requested_by, decided_at)
    values (p_coach, v_fighter.id, case when v_reused then 'pending' else 'approved' end::public.link_status,
            p_actor, case when v_reused then null else now() end)
    on conflict (coach_id, fighter_id) do nothing;
  end if;

  if v_event.id is not null then
    select * into v_existing_reg from public.event_registrations where event_id = v_event.id and fighter_id = v_fighter.id;
    if found then
      v_result := jsonb_build_object('status', 'already_registered', 'fighter_code', v_fighter.fighter_code,
                                     'registration_status', v_existing_reg.status);
      insert into public.registration_submissions (submission_key, kind, result) values (v_key, 'fighter', v_result);
      return v_result;
    end if;

    insert into public.event_registrations (event_id, fighter_id, status, submitted_via, submitted_by_user,
      submitted_by_coach, declared_weight_g, weight_unit_entered, weight_recorded_at, preferred_weight_class_id,
      division, competition_level, is_available, availability_notes, clearance_status, submitted_at, late_override_by)
    values (v_event.id, v_fighter.id, 'submitted',
            case when p_coach is not null then 'coach' when p_actor is not null then 'admin' else 'self' end,
            p_actor, p_coach, v_weight, case when v_weight is null then null else p ->> 'weight_unit' end,
            case when v_weight is null then null else now() end,
            nullif(p ->> 'preferred_weight_class_id', '')::uuid, p ->> 'division',
            coalesce(p ->> 'competition_level', 'amateur')::public.competition_level,
            coalesce((p ->> 'is_available')::boolean, true), nullif(p ->> 'availability_notes', ''),
            case when coalesce((v_event.eligibility ->> 'require_clearance')::boolean, false)
                 then 'pending' else 'not_required' end::public.clearance_status,
            now(), case when v_late then p_actor end)
    returning id into v_reg_id;

    for v_doc in select * from jsonb_array_elements(coalesce(p -> 'documents', '[]'::jsonb)) loop
      insert into public.registration_documents (registration_id, kind, storage_path, mime_type, size_bytes)
      values (v_reg_id, v_doc ->> 'kind', v_doc ->> 'path', v_doc ->> 'mime_type', (v_doc ->> 'size_bytes')::int);
    end loop;
  end if;

  perform private.enqueue_email(v_org, v_event.id, 'fighter_registration_confirmation',
    (select email from public.fighter_private where fighter_id = v_fighter.id),
    (select legal_name from public.fighter_private where fighter_id = v_fighter.id),
    jsonb_build_object('fighter_name', v_fighter.fight_name, 'fighter_code', v_fighter.fighter_code,
                       'event_name', v_event.name, 'event_slug', v_event.slug, 'reused', v_reused,
                       'registered_at', now()),
    'fighter_registration:' || v_key::text, 'fighter', v_fighter.id);

  if p_coach is not null then
    perform private.enqueue_email(v_org, v_event.id, 'coach_fighter_submitted', v_coach.email, v_coach.full_name,
      jsonb_build_object('fighter_name', v_fighter.fight_name, 'fighter_code', v_fighter.fighter_code,
                         'event_name', v_event.name),
      'coach_fighter_submitted:' || v_key::text, 'fighter', v_fighter.id);
  end if;

  v_result := jsonb_build_object('status', case when v_reused then 'reused' else 'created' end,
                                 'fighter_code', v_fighter.fighter_code, 'event_name', v_event.name,
                                 'registration_id', v_reg_id);
  insert into public.registration_submissions (submission_key, kind, result) values (v_key, 'fighter', v_result);
  return v_result;
end $$;

-- ---------- coach registration -----------------------------------------------------
create or replace function public.svc_register_coach(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key uuid := (p ->> 'submission_key')::uuid;
  v_prev jsonb;
  v_org uuid;
  v_event public.events;
  v_email text := lower(trim(p ->> 'email'));
  v_coach uuid;
  v_gym uuid;
  v_result jsonb := jsonb_build_object('status', 'received');
begin
  select result into v_prev from public.registration_submissions where submission_key = v_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  if nullif(p ->> 'event_slug', '') is not null then
    select * into v_event from public.events where slug = p ->> 'event_slug';
    if not found or v_event.status in ('draft', 'cancelled', 'completed') then
      perform private.raise_app('event_not_found', 'This event is not accepting registrations.');
    end if;
    if not private.event_registration_open(v_event) and not v_event.allow_late_registration then
      perform private.raise_app('registration_closed', 'Registration for this event is closed.');
    end if;
    v_org := v_event.org_id;
  else
    select id into v_org from public.organizations order by created_at limit 1;
  end if;

  perform private.set_context(null, 'system', 'coach registration');
  select id into v_coach from public.coaches where org_id = v_org and email = v_email;
  if v_coach is null then
    v_gym := private.resolve_gym(v_org, nullif(p ->> 'gym_id', '')::uuid, p ->> 'gym_name', p ->> 'city', p ->> 'country');
    insert into public.coaches (org_id, gym_id, full_name, email, phone_country_code, phone, city, country,
                                coaching_experience_years, experience_summary, verification_info, declared_roster)
    values (v_org, v_gym, trim(p ->> 'full_name'), v_email, nullif(p ->> 'phone_country_code', ''),
            nullif(p ->> 'phone', ''), nullif(trim(p ->> 'city'), ''), nullif(trim(p ->> 'country'), ''),
            nullif(p ->> 'coaching_experience_years', '')::smallint, nullif(p ->> 'experience_summary', ''),
            nullif(p ->> 'verification_info', ''), coalesce(p -> 'roster', '[]'::jsonb))
    returning id into v_coach;
  end if;
  -- An existing coach gets the same neutral response (no account enumeration).
  if v_event.id is not null then
    insert into public.coach_events (coach_id, event_id) values (v_coach, v_event.id) on conflict do nothing;
  end if;
  perform private.enqueue_email(v_org, v_event.id, 'coach_registration_confirmation', v_email, trim(p ->> 'full_name'),
    jsonb_build_object('coach_name', trim(p ->> 'full_name'), 'event_name', v_event.name),
    'coach_registration:' || v_key::text, 'coach', v_coach);
  insert into public.registration_submissions (submission_key, kind, result) values (v_key, 'coach', v_result);
  return v_result;
end $$;

-- Link an invited auth user to a verified coach record.
create or replace function public.svc_link_coach_user(p_actor uuid, p_coach uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.coaches;
begin
  select * into c from public.coaches where id = p_coach for update;
  if not found or not private.is_org_admin(c.org_id, p_actor) then
    perform private.raise_app('forbidden', 'Coach not found.');
  end if;
  if c.verification_status <> 'verified' then
    perform private.raise_app('invalid', 'Verify the coach before inviting them.');
  end if;
  perform private.set_context(p_actor, 'user', 'coach invited');
  update public.coaches set user_id = p_user where id = p_coach;
  insert into public.user_profiles (id, org_id, email, full_name) values (p_user, c.org_id, c.email, c.full_name)
  on conflict (id) do update set org_id = excluded.org_id;
  insert into public.user_roles (user_id, org_id, role, granted_by) values (p_user, c.org_id, 'coach', p_actor)
  on conflict do nothing;
end $$;

-- ---------- coach & duplicate management (authenticated) --------------------------
create or replace function public.verify_coach(p_coach uuid, p_status public.verification_status, p_notes text default null)
returns public.coaches language plpgsql security definer set search_path = '' as $$
declare c public.coaches;
begin
  select * into c from public.coaches where id = p_coach for update;
  if not found or not private.is_org_admin(c.org_id) then
    raise exception 'coach not found' using errcode = 'no_data_found';
  end if;
  perform private.set_context(auth.uid(), 'user', p_notes);
  update public.coaches set verification_status = p_status, verification_notes = coalesce(p_notes, verification_notes),
         verified_by = auth.uid(), verified_at = now()
   where id = p_coach returning * into c;
  if p_status in ('verified', 'rejected') then
    perform private.enqueue_email(c.org_id, null, 'coach_' || p_status::text, c.email, c.full_name,
      jsonb_build_object('coach_name', c.full_name, 'reason', case when p_status = 'rejected' then p_notes end),
      format('coach_%s:%s:%s', p_status, c.id, to_char(now(), 'YYYYMMDDHH24MISSMS')), 'coach', c.id);
  end if;
  return c;
end $$;

create or replace function public.merge_fighters(p_keep uuid, p_drop uuid, p_reason text)
returns public.fighters language plpgsql security definer set search_path = '' as $$
declare k public.fighters; d public.fighters;
begin
  if p_keep = p_drop then raise exception 'cannot merge a fighter into itself' using errcode = 'check_violation'; end if;
  -- Lock in a stable order to avoid deadlocks.
  perform 1 from public.fighters where id in (p_keep, p_drop) order by id for update;
  select * into k from public.fighters where id = p_keep;
  select * into d from public.fighters where id = p_drop;
  if k.id is null or d.id is null or k.org_id <> d.org_id or not private.is_org_admin(k.org_id) then
    raise exception 'fighter not found' using errcode = 'no_data_found';
  end if;
  if k.status = 'merged' or d.status = 'merged' then
    raise exception 'one of these profiles has already been merged' using errcode = 'check_violation';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'a reason is required' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.bout_participants where fighter_id = p_drop and is_active) then
    raise exception 'resolve or cancel the active bouts of the duplicate profile first' using errcode = 'check_violation';
  end if;

  perform private.set_context(auth.uid(), 'user', p_reason);
  -- Move registrations for events the kept profile is not already registered for.
  update public.event_registrations er set fighter_id = p_keep
   where er.fighter_id = p_drop
     and not exists (select 1 from public.event_registrations x where x.fighter_id = p_keep and x.event_id = er.event_id);
  update public.event_registrations set status = 'rejected', rejection_reason = 'Duplicate profile merged into ' || k.fighter_code
   where fighter_id = p_drop and status not in ('rejected');
  insert into public.coach_fighters (coach_id, fighter_id, status, requested_by, decided_by, decided_at)
  select coach_id, p_keep, status, requested_by, decided_by, decided_at from public.coach_fighters where fighter_id = p_drop
  on conflict (coach_id, fighter_id) do nothing;
  update public.fighter_duplicate_flags set resolution = 'merged', resolved_by = auth.uid(), resolved_at = now()
   where (fighter_id = p_drop and candidate_fighter_id = p_keep) or (fighter_id = p_keep and candidate_fighter_id = p_drop);
  -- The dropped ID is retired permanently (never reused); history keeps pointing at it.
  update public.fighters set status = 'merged', merged_into = p_keep where id = p_drop;
  select * into k from public.fighters where id = p_keep;
  return k;
end $$;

-- ---------- events -----------------------------------------------------------------
-- New events receive copies of the organisation's weight-class templates and rules.
create or replace function private.events_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.weight_classes (org_id, event_id, name, division, min_g, max_g, allowed_diff_g, sort_order)
  select org_id, new.id, name, division, min_g, max_g, allowed_diff_g, sort_order
    from public.weight_classes where org_id = new.org_id and event_id is null and is_active;
  insert into public.matchmaking_rules (org_id, event_id, config, updated_by)
  select org_id, new.id, config, new.created_by from public.matchmaking_rules where org_id = new.org_id and event_id is null;
  if new.created_by is not null and not private.is_org_admin(new.org_id, new.created_by) then
    insert into public.event_admins (event_id, user_id, role, granted_by) values (new.id, new.created_by, 'event_admin', new.created_by);
  end if;
  return null;
end $$;
create trigger events_after_insert after insert on public.events for each row execute function private.events_after_insert();

-- Date / venue changes notify everyone with a live offer or booked bout.
create or replace function private.events_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b record;
begin
  if (new.starts_at, new.venue_name, new.venue_city, new.venue_address)
     is not distinct from (old.starts_at, old.venue_name, old.venue_city, old.venue_address) then
    return null;
  end if;
  for b in select id from public.bouts
            where event_id = new.id and status in ('offer_sent', 'awaiting_responses', 'accepted_one', 'accepted_both', 'confirmed')
  loop
    perform private.notify_bout_parties(b.id, 'event_updated', jsonb_build_object(
      'dedupe', txid_current()::text, 'starts_at', new.starts_at, 'timezone', new.timezone,
      'venue_name', new.venue_name, 'venue_city', new.venue_city));
  end loop;
  return null;
end $$;
create trigger events_after_update after update on public.events for each row execute function private.events_after_update();

-- Event status cannot be set to values that contradict publication.
create or replace function private.events_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'draft' and (new.is_public or new.fight_card_published) then
    raise exception 'draft events cannot be public' using errcode = 'check_violation';
  end if;
  if not new.is_public then new.fight_card_published := false; end if;
  return new;
end $$;
create trigger events_guard before insert or update on public.events for each row execute function private.events_guard();

create or replace function public.announce_event(p_event uuid, p_message text)
returns integer language plpgsql security definer set search_path = '' as $$
declare e public.events; n integer := 0; r record; v_tag text := to_char(now(), 'YYYYMMDDHH24MISS');
begin
  select * into e from public.events where id = p_event;
  if not found or not private.can_manage_event(p_event) then raise exception 'event not found' using errcode = 'no_data_found'; end if;
  if length(trim(p_message)) < 5 then raise exception 'message too short' using errcode = 'check_violation'; end if;
  for r in select fp.email, fp.legal_name, f.fight_name from public.event_registrations er
             join public.fighters f on f.id = er.fighter_id join public.fighter_private fp on fp.fighter_id = f.id
            where er.event_id = p_event and er.status in ('submitted', 'under_review', 'approved')
  loop
    if private.enqueue_email(e.org_id, e.id, 'event_announcement', r.email, r.legal_name,
         jsonb_build_object('event_name', e.name, 'event_slug', e.slug, 'message', p_message, 'fighter_name', r.fight_name),
         format('event_announcement:%s:%s:%s', e.id, v_tag, r.email), 'event', e.id, 'event_announcements') is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------- matchmaking ------------------------------------------------------------
-- Everything the engine needs about approved/submitted registrants of one event.
create or replace function public.svc_matchmaking_pool(p_actor uuid, p_event uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e public.events;
begin
  select * into e from public.events where id = p_event;
  if not found or not private.can_matchmake_event(p_event, p_actor) then
    perform private.raise_app('forbidden', 'Event not found.');
  end if;
  return jsonb_build_object(
    'event', jsonb_build_object('id', e.id, 'name', e.name, 'starts_at', e.starts_at, 'eligibility', e.eligibility,
                                'default_rounds', e.default_rounds, 'default_round_minutes', e.default_round_minutes),
    'rules', coalesce((select config from public.matchmaking_rules where event_id = p_event),
                      (select config from public.matchmaking_rules where org_id = e.org_id and event_id is null), '{}'::jsonb),
    'weight_classes', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'division', w.division,
                                  'min_g', w.min_g, 'max_g', w.max_g, 'allowed_diff_g', w.allowed_diff_g) order by w.max_g)
                                from public.weight_classes w where w.event_id = p_event and w.is_active), '[]'::jsonb),
    'candidates', coalesce((select jsonb_agg(jsonb_build_object(
        'fighter_id', f.id, 'fighter_code', f.fighter_code, 'fight_name', f.fight_name, 'gym_id', f.gym_id,
        'gym_name', (select name from public.gyms g where g.id = f.gym_id),
        'division', er.division, 'competition_level', er.competition_level,
        'primary_style', f.primary_style, 'skill_level', f.skill_level,
        'date_of_birth', fp.date_of_birth, 'registration_status', er.status, 'registration_id', er.id,
        'weight_g', er.declared_weight_g, 'weight_recorded_at', er.weight_recorded_at,
        'is_available', er.is_available, 'clearance_status', er.clearance_status,
        'record', (select to_jsonb(r) - 'id' - 'fighter_id' from public.fighter_records r
                    where r.fighter_id = f.id order by (r.kind = 'verified') desc limit 1),
        'previous_opponents', coalesce((select jsonb_agg(distinct case when b.fighter_a_id = f.id then b.fighter_b_id else b.fighter_a_id end)
                                          from public.bouts b where b.status = 'completed'
                                           and f.id in (b.fighter_a_id, b.fighter_b_id)), '[]'::jsonb),
        'active_bout_in_event', exists (select 1 from public.bout_participants bp
                                         where bp.fighter_id = f.id and bp.event_id = p_event and bp.is_active),
        'active_bouts_elsewhere', (select count(*) from public.bout_participants bp
                                    where bp.fighter_id = f.id and bp.event_id <> p_event and bp.is_active)
      ) order by f.fight_name)
      from public.event_registrations er
      join public.fighters f on f.id = er.fighter_id and f.status = 'active'
      join public.fighter_private fp on fp.fighter_id = f.id
     where er.event_id = p_event and er.status in ('submitted', 'under_review', 'approved')), '[]'::jsonb));
end $$;

create or replace function public.svc_store_suggestions(p_actor uuid, p_event uuid, p_rules jsonb, p_rows jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not private.can_matchmake_event(p_event, p_actor) then perform private.raise_app('forbidden', 'Event not found.'); end if;
  update public.matchmaking_suggestions set status = 'stale' where event_id = p_event and status = 'open';
  insert into public.matchmaking_suggestions (event_id, fighter_a_id, fighter_b_id, score, classification, evaluation,
                                              rules_snapshot, generated_by)
  select p_event, least((r ->> 'fighter_a_id')::uuid, (r ->> 'fighter_b_id')::uuid),
         greatest((r ->> 'fighter_a_id')::uuid, (r ->> 'fighter_b_id')::uuid),
         (r ->> 'score')::numeric, (r ->> 'classification')::public.match_classification, r -> 'evaluation', p_rules, p_actor
    from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- bouts ------------------------------------------------------------------
create or replace function public.svc_create_bout(p_actor uuid, p jsonb) returns public.bouts
language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  b public.bouts;
  v_a uuid := (p ->> 'fighter_a_id')::uuid;
  v_b uuid := (p ->> 'fighter_b_id')::uuid;
  v_class text := p -> 'evaluation' ->> 'classification';
  v_override text := nullif(trim(p ->> 'override_reason'), '');
  v_replaces public.bouts;
begin
  select * into e from public.events where id = (p ->> 'event_id')::uuid;
  if not found or not private.can_matchmake_event(e.id, p_actor) then perform private.raise_app('forbidden', 'Event not found.'); end if;
  if e.status in ('cancelled', 'completed', 'draft') then
    perform private.raise_app('invalid', 'Bouts cannot be created for an event in status ' || e.status);
  end if;
  if (select count(*) from public.event_registrations
       where event_id = e.id and fighter_id in (v_a, v_b) and status = 'approved') < 2 then
    perform private.raise_app('ineligible', 'Both fighters need an approved registration for this event.');
  end if;
  if v_class is null then perform private.raise_app('invalid', 'A server-side evaluation is required.'); end if;
  if v_class in ('requires_review', 'ineligible') and (v_override is null or length(v_override) < 10) then
    perform private.raise_app('override_required',
      'This pairing was classified "' || replace(v_class, '_', ' ') || '". Record a reason (10+ characters) to override.');
  end if;
  if nullif(p ->> 'weight_class_id', '') is not null and not exists (
       select 1 from public.weight_classes where id = (p ->> 'weight_class_id')::uuid and event_id = e.id) then
    perform private.raise_app('invalid', 'Weight class does not belong to this event.');
  end if;

  perform private.set_context(p_actor, 'user', coalesce(v_override, 'bout created'));

  if nullif(p ->> 'replaces_bout_id', '') is not null then
    select * into v_replaces from public.bouts where id = (p ->> 'replaces_bout_id')::uuid and event_id = e.id for update;
    if not found then perform private.raise_app('invalid', 'Original bout not found.'); end if;
    if v_replaces.status not in ('cancelled', 'completed') then
      if not private.can_manage_event(e.id, p_actor) then
        perform private.raise_app('forbidden', 'Only event administrators can replace a bout.');
      end if;
      perform private.set_context(p_actor, 'user', 'Replaced by a new pairing');
      update public.bouts set status = 'cancelled' where id = v_replaces.id;
      update public.bout_offers set status = 'withdrawn', revoked_at = now(), revoked_reason = 'bout replaced'
       where bout_id = v_replaces.id and status = 'pending';
      perform private.set_context(p_actor, 'user', coalesce(v_override, 'replacement bout created'));
    end if;
  end if;

  insert into public.bouts (org_id, event_id, fighter_a_id, fighter_b_id, weight_class_id, contracted_weight_g, rounds,
                            round_minutes, rules_text, evaluation, override_reason, suggestion_id, replaces_bout_id,
                            admin_notes, created_by)
  values (e.org_id, e.id, v_a, v_b, nullif(p ->> 'weight_class_id', '')::uuid, nullif(p ->> 'contracted_weight_g', '')::int,
          coalesce((p ->> 'rounds')::smallint, e.default_rounds),
          coalesce((p ->> 'round_minutes')::smallint, e.default_round_minutes),
          coalesce(nullif(p ->> 'rules_text', ''), e.rules_text), p -> 'evaluation', v_override,
          nullif(p ->> 'suggestion_id', '')::uuid, v_replaces.id, nullif(p ->> 'admin_notes', ''), p_actor)
  returning * into b;

  if b.suggestion_id is not null then
    update public.matchmaking_suggestions set status = 'converted', bout_id = b.id where id = b.suggestion_id;
  end if;
  return b;
end $$;

-- What a fighter is shown about their opponent: public, non-sensitive information only.
create or replace function private.offer_opponent_json(p_fighter uuid, p_event uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'fight_name', f.fight_name, 'nickname', f.nickname, 'country', f.country, 'primary_style', f.primary_style,
    'height_cm', f.height_cm, 'reach_cm', f.reach_cm,
    'gym', (select g.name from public.gyms g where g.id = f.gym_id),
    'declared_weight_g', (select er.declared_weight_g from public.event_registrations er
                           where er.fighter_id = f.id and er.event_id = p_event),
    'record', (select jsonb_build_object('wins', r.wins, 'losses', r.losses, 'draws', r.draws,
                                         'no_contests', r.no_contests, 'verified', r.kind = 'verified')
                 from public.fighter_records r where r.fighter_id = f.id order by (r.kind = 'verified') desc limit 1))
  from public.fighters f where f.id = p_fighter
$$;

create or replace function public.svc_issue_offers(p_actor uuid, p_bout uuid, p_expires_at timestamptz, p_offers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.bouts;
  e public.events;
  w public.weight_classes;
  v_version int;
  o jsonb;
  v_fighter uuid;
  v_terms jsonb;
  v_fp record;
begin
  select * into b from public.bouts where id = p_bout for update;
  if not found or not private.can_matchmake_event(b.event_id, p_actor) then perform private.raise_app('forbidden', 'Bout not found.'); end if;
  if b.status not in ('draft', 'expired', 'under_review') then
    perform private.raise_app('invalid', 'Offers can only be sent from draft, expired or under-review bouts.');
  end if;
  if p_expires_at < now() + interval '1 hour' or p_expires_at > now() + interval '30 days' then
    perform private.raise_app('invalid', 'Offer expiry must be between 1 hour and 30 days from now.');
  end if;
  if jsonb_array_length(p_offers) <> 2 then perform private.raise_app('invalid', 'Exactly two offers are required.'); end if;
  if exists (select 1 from public.event_registrations er where er.event_id = b.event_id
              and er.fighter_id in (b.fighter_a_id, b.fighter_b_id) and er.status <> 'approved') then
    perform private.raise_app('ineligible', 'Both fighters need an approved registration.');
  end if;

  select * into e from public.events where id = b.event_id;
  select * into w from public.weight_classes where id = b.weight_class_id;
  v_version := b.offer_version + 1;
  perform private.set_context(p_actor, 'user', 'offers issued (v' || v_version || ')');

  update public.bout_offers set status = 'superseded', revoked_at = now(), revoked_reason = 'new offer version'
   where bout_id = b.id and status in ('pending', 'accepted');

  update public.bouts set offer_version = v_version, offer_expires_at = p_expires_at, status = 'offer_sent'
   where id = b.id returning * into b;

  v_terms := jsonb_build_object(
    'bout_code', b.bout_code, 'event_name', e.name, 'event_slug', e.slug,
    'starts_at', coalesce(b.proposed_starts_at, e.starts_at), 'timezone', e.timezone,
    'venue_name', e.venue_name, 'venue_city', e.venue_city, 'venue_country', e.venue_country,
    'weight_class', w.name, 'weight_limit_g', w.max_g, 'contracted_weight_g', b.contracted_weight_g,
    'rounds', b.rounds, 'round_minutes', b.round_minutes, 'rules_text', b.rules_text, 'offer_version', v_version);

  for o in select * from jsonb_array_elements(p_offers) loop
    v_fighter := case o ->> 'corner' when 'A' then b.fighter_a_id when 'B' then b.fighter_b_id end;
    if v_fighter is null then perform private.raise_app('invalid', 'Corner must be A or B.'); end if;
    insert into public.bout_offers (id, bout_id, fighter_id, corner, offer_version, token_nonce, token_hash, expires_at,
                                    terms_snapshot, sent_at, created_by)
    values ((o ->> 'id')::uuid, b.id, v_fighter, o ->> 'corner', v_version, o ->> 'nonce', o ->> 'token_hash', p_expires_at,
            v_terms || jsonb_build_object('opponent', private.offer_opponent_json(
              case when v_fighter = b.fighter_a_id then b.fighter_b_id else b.fighter_a_id end, b.event_id)),
            now(), p_actor);
    select fp.email, fp.legal_name, f.fight_name into v_fp
      from public.fighter_private fp join public.fighters f on f.id = fp.fighter_id where fp.fighter_id = v_fighter;
    perform private.enqueue_email(b.org_id, b.event_id, 'bout_offer', v_fp.email, v_fp.legal_name,
      jsonb_build_object('offer_id', o ->> 'id', 'fighter_name', v_fp.fight_name, 'event_name', e.name,
                         'opponent_name', (select fight_name from public.fighters where id =
                            case when v_fighter = b.fighter_a_id then b.fighter_b_id else b.fighter_a_id end),
                         'weight_class', w.name, 'rounds', b.rounds, 'round_minutes', b.round_minutes,
                         'starts_at', coalesce(b.proposed_starts_at, e.starts_at), 'timezone', e.timezone,
                         'venue_name', e.venue_name, 'expires_at', p_expires_at),
      'bout_offer:' || (o ->> 'id'), 'offer', (o ->> 'id')::uuid);
  end loop;
  return jsonb_build_object('bout_id', b.id, 'offer_version', v_version, 'status', b.status);
end $$;

-- Re-send the offer email (same link: the token is re-derived from the stored nonce).
create or replace function public.resend_offer_email(p_offer uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.bout_offers; l public.email_logs; v_id uuid;
begin
  select * into o from public.bout_offers where id = p_offer;
  if not found or not private.can_view_bout(o.bout_id) then raise exception 'offer not found' using errcode = 'no_data_found'; end if;
  if o.status <> 'pending' or o.expires_at <= now() then
    raise exception 'only pending, unexpired offers can be re-sent' using errcode = 'check_violation';
  end if;
  select * into l from public.email_logs where idempotency_key = 'bout_offer:' || p_offer;
  insert into public.email_logs (org_id, event_id, template, to_email, to_name, payload, idempotency_key, entity_type, entity_id, created_by)
  values (l.org_id, l.event_id, l.template, l.to_email, l.to_name, l.payload,
          'bout_offer:' || p_offer || ':resend:' || to_char(now(), 'YYYYMMDDHH24MISSMS'), 'offer', p_offer, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Offer page data. Records first view and moves offer_sent → awaiting_responses.
create or replace function public.svc_get_offer(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.bout_offers; b public.bouts; f public.fighters;
begin
  select * into o from public.bout_offers where token_hash = p_token_hash;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into b from public.bouts where id = o.bout_id;
  select * into f from public.fighters where id = o.fighter_id;
  if o.status = 'pending' and o.expires_at > now() and o.offer_version = b.offer_version then
    if o.first_viewed_at is null then
      update public.bout_offers set first_viewed_at = now() where id = o.id;
      if b.status = 'offer_sent' then
        perform private.set_context(null, 'fighter', 'offer opened');
        update public.bouts set status = 'awaiting_responses' where id = b.id and status = 'offer_sent';
      end if;
    end if;
  end if;
  return jsonb_build_object(
    'ok', true,
    'offer_id', o.id,
    'status', case when o.status = 'pending' and o.expires_at <= now() then 'expired' else o.status::text end,
    'can_respond', o.status = 'pending' and o.expires_at > now() and o.offer_version = b.offer_version
                   and b.status in ('offer_sent', 'awaiting_responses', 'accepted_one'),
    'expires_at', o.expires_at,
    'responded_at', o.responded_at,
    'fighter', jsonb_build_object('fight_name', f.fight_name, 'fighter_code', f.fighter_code),
    'terms', o.terms_snapshot);
end $$;

create or replace function public.svc_respond_offer(p_token_hash text, p_response public.offer_response,
                                                    p_reason text, p_ip_hash text, p_user_agent text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_bout_id uuid;
  o public.bout_offers;
  b public.bouts;
  e public.events;
  other public.bout_offers;
  f public.fighters;
  r record;
  v_new public.bout_status;
begin
  select bout_id into v_bout_id from public.bout_offers where token_hash = p_token_hash;
  if v_bout_id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  -- Lock the bout first (same order everywhere), then the offer.
  select * into b from public.bouts where id = v_bout_id for update;
  select * into o from public.bout_offers where token_hash = p_token_hash for update;

  if o.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', case o.status when 'accepted' then 'already_responded'
      when 'declined' then 'already_responded' else o.status::text end);
  end if;
  if o.offer_version <> b.offer_version then return jsonb_build_object('ok', false, 'code', 'superseded'); end if;
  if o.expires_at <= now() then return jsonb_build_object('ok', false, 'code', 'expired'); end if;
  if b.status not in ('offer_sent', 'awaiting_responses', 'accepted_one') then
    return jsonb_build_object('ok', false, 'code', 'not_open');
  end if;

  perform private.set_context(null, 'fighter', case when p_response = 'decline' then coalesce(nullif(trim(p_reason), ''), 'declined') else 'accepted' end);
  insert into public.bout_responses (offer_id, bout_id, fighter_id, response, decline_reason, ip_hash, user_agent)
  values (o.id, b.id, o.fighter_id, p_response, case when p_response = 'decline' then left(p_reason, 1000) end,
          p_ip_hash, left(p_user_agent, 400));
  update public.bout_offers set status = case when p_response = 'accept' then 'accepted' else 'declined' end::public.offer_status,
         responded_at = now() where id = o.id;

  select * into other from public.bout_offers
   where bout_id = b.id and offer_version = o.offer_version and id <> o.id;

  if p_response = 'decline' then
    v_new := 'declined';
    update public.bout_offers set status = 'withdrawn', revoked_at = now(), revoked_reason = 'opponent declined'
     where id = other.id and status = 'pending';
  elsif other.status = 'accepted' then
    v_new := 'accepted_both';
  else
    v_new := 'accepted_one';
  end if;
  if b.status = 'offer_sent' and v_new <> 'declined' and v_new <> 'accepted_one' then
    -- offer_sent → accepted_both is not a legal single step; pass through accepted_one.
    update public.bouts set status = 'accepted_one' where id = b.id;
  end if;
  update public.bouts set status = v_new where id = b.id and status <> v_new returning * into b;
  select * into b from public.bouts where id = v_bout_id;

  select * into e from public.events where id = b.event_id;
  select * into f from public.fighters where id = o.fighter_id;

  -- Fighter's own confirmation.
  perform private.enqueue_email(b.org_id, b.event_id, 'offer_' || case when p_response = 'accept' then 'accepted' else 'declined' end || '_confirmation',
    fp.email, fp.legal_name,
    jsonb_build_object('fighter_name', f.fight_name, 'event_name', e.name, 'bout_code', b.bout_code),
    'offer_response_fighter:' || o.id, 'offer', o.id)
  from public.fighter_private fp where fp.fighter_id = o.fighter_id;

  -- Administrators: after every response, plus a dedicated notice when both have answered.
  for r in select * from private.event_admin_recipients(b.event_id) loop
    perform private.enqueue_email(b.org_id, b.event_id,
      case when v_new = 'accepted_both' then 'admin_both_accepted'
           when p_response = 'decline' then 'admin_offer_declined' else 'admin_offer_accepted' end,
      r.email, r.full_name,
      jsonb_build_object('fighter_name', f.fight_name, 'bout_code', b.bout_code, 'event_name', e.name,
                         'bout_id', b.id, 'reason', case when p_response = 'decline' then left(p_reason, 500) end),
      format('offer_response_admin:%s:%s', o.id, r.user_id), 'bout', b.id);
  end loop;

  -- Coaches, if the event allows and the link is approved.
  if e.notify_coaches then
    perform private.enqueue_email(b.org_id, b.event_id, 'coach_offer_response', c.email, c.full_name,
      jsonb_build_object('fighter_name', f.fight_name, 'bout_code', b.bout_code, 'event_name', e.name,
                         'response', p_response),
      format('offer_response_coach:%s:%s', o.id, c.id), 'bout', b.id, 'coach_updates')
    from public.coach_fighters cf join public.coaches c on c.id = cf.coach_id
   where cf.fighter_id = o.fighter_id and cf.status = 'approved' and c.verification_status = 'verified';
  end if;

  return jsonb_build_object('ok', true, 'response', p_response, 'bout_status', b.status);
end $$;

-- Scheduled: expire overdue offers and the bouts that depended on them.
create or replace function public.svc_expire_offers() returns integer
language plpgsql security definer set search_path = '' as $$
declare b record; n integer := 0; r record;
begin
  perform private.set_context(null, 'system', 'offer expired');
  for b in
    select distinct bo.bout_id from public.bout_offers bo join public.bouts bt on bt.id = bo.bout_id
     where bo.status = 'pending' and bo.expires_at <= now() and bo.offer_version = bt.offer_version
       and bt.status in ('offer_sent', 'awaiting_responses', 'accepted_one')
     order by bo.bout_id
  loop
    perform 1 from public.bouts where id = b.bout_id for update;
    update public.bout_offers set status = 'expired' where bout_id = b.bout_id and status = 'pending';
    update public.bouts set status = 'expired' where id = b.bout_id
       and status in ('offer_sent', 'awaiting_responses', 'accepted_one');
    perform private.notify_bout_parties(b.bout_id, 'offer_expired', jsonb_build_object('dedupe', 'v' || (select offer_version from public.bouts where id = b.bout_id)));
    for r in select * from private.event_admin_recipients((select event_id from public.bouts where id = b.bout_id)) loop
      perform private.enqueue_email((select org_id from public.bouts where id = b.bout_id),
        (select event_id from public.bouts where id = b.bout_id), 'admin_offer_expired', r.email, r.full_name,
        jsonb_build_object('bout_code', (select bout_code from public.bouts where id = b.bout_id), 'bout_id', b.bout_id),
        format('admin_offer_expired:%s:v%s:%s', b.bout_id, (select offer_version from public.bouts where id = b.bout_id), r.user_id),
        'bout', b.bout_id);
    end loop;
    n := n + 1;
  end loop;
  -- Stray pending offers of superseded versions.
  update public.bout_offers set status = 'expired' where status = 'pending' and expires_at <= now();
  return n;
end $$;

create or replace function public.svc_queue_offer_reminders(p_hours integer default 24) returns integer
language plpgsql security definer set search_path = '' as $$
declare o record; n integer := 0;
begin
  for o in
    select bo.*, fp.email, fp.legal_name, f.fight_name, e.name as event_name, bt.org_id, bt.event_id
      from public.bout_offers bo join public.bouts bt on bt.id = bo.bout_id
      join public.events e on e.id = bt.event_id
      join public.fighters f on f.id = bo.fighter_id join public.fighter_private fp on fp.fighter_id = f.id
     where bo.status = 'pending' and bo.reminder_sent_at is null and bo.offer_version = bt.offer_version
       and bo.expires_at > now() and bo.expires_at <= now() + make_interval(hours => p_hours)
     for update of bo skip locked
  loop
    perform private.enqueue_email(o.org_id, o.event_id, 'offer_expiry_reminder', o.email, o.legal_name,
      jsonb_build_object('offer_id', o.id, 'fighter_name', o.fight_name, 'event_name', o.event_name, 'expires_at', o.expires_at),
      'offer_reminder:' || o.id, 'offer', o.id, 'reminders');
    update public.bout_offers set reminder_sent_at = now() where id = o.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- email dispatch (service role) ------------------------------------------
create or replace function public.svc_claim_emails(p_limit integer default 20)
returns setof public.email_logs language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.email_logs l set status = 'sending', locked_until = now() + interval '5 minutes',
         attempts = l.attempts + 1
   where l.id in (select id from public.email_logs
                   where (status = 'queued' and next_attempt_at <= now())
                      or (status = 'sending' and locked_until < now())     -- crashed worker
                   order by next_attempt_at limit p_limit for update skip locked)
  returning l.*;
end $$;

create or replace function public.svc_email_sent(p_id uuid, p_provider_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.email_logs set status = 'sent', provider_message_id = p_provider_id, sent_at = now(),
         locked_until = null, last_error = null where id = p_id and status = 'sending';
end $$;

create or replace function public.svc_email_failed(p_id uuid, p_error text, p_permanent boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.email_logs set
    status = case when p_permanent or attempts >= max_attempts then 'failed' else 'queued' end::public.email_status,
    next_attempt_at = now() + make_interval(mins => least(power(2, attempts)::int, 240)),
    locked_until = null, last_error = left(p_error, 2000)
   where id = p_id and status = 'sending';
end $$;

create or replace function public.svc_email_delivery(p_provider_id text, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.email_logs set delivery_status = p_status, delivery_updated_at = now()
   where provider_message_id = p_provider_id and p_status in ('delivered', 'delayed', 'bounced', 'complained');
end $$;

-- Offer token material for the dispatcher (never exposed elsewhere).
create or replace function public.svc_offer_token_material(p_offer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('offer_id', id, 'nonce', token_nonce, 'status', status, 'expires_at', expires_at)
    from public.bout_offers where id = p_offer
$$;

create or replace function public.retry_email(p_id uuid) returns public.email_logs
language plpgsql security definer set search_path = '' as $$
declare l public.email_logs;
begin
  select * into l from public.email_logs where id = p_id for update;
  if not found or not (private.is_org_admin(l.org_id) or (l.event_id is not null and private.can_manage_event(l.event_id))) then
    raise exception 'email not found' using errcode = 'no_data_found';
  end if;
  if l.status not in ('failed', 'cancelled') then
    raise exception 'only failed or cancelled emails can be retried' using errcode = 'check_violation';
  end if;
  update public.email_logs set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null
   where id = p_id returning * into l;
  return l;
end $$;

create or replace function public.resend_email(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare l public.email_logs; v_id uuid;
begin
  select * into l from public.email_logs where id = p_id;
  if not found or not (private.is_org_admin(l.org_id) or (l.event_id is not null and private.can_manage_event(l.event_id))) then
    raise exception 'email not found' using errcode = 'no_data_found';
  end if;
  if l.status <> 'sent' then raise exception 'use retry for emails that were not sent' using errcode = 'check_violation'; end if;
  insert into public.email_logs (org_id, event_id, template, to_email, to_name, payload, idempotency_key, entity_type, entity_id, created_by)
  values (l.org_id, l.event_id, l.template, l.to_email, l.to_name, l.payload,
          left(split_part(l.idempotency_key, ':resend:', 1), 150) || ':resend:' || to_char(now(), 'YYYYMMDDHH24MISSMS'),
          l.entity_type, l.entity_id, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Resend the registration confirmation (fighter ID) to a fighter.
create or replace function public.resend_fighter_confirmation(p_fighter uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare f public.fighters; fp public.fighter_private;
begin
  select * into f from public.fighters where id = p_fighter;
  if not found or not private.can_edit_fighter(p_fighter) then raise exception 'fighter not found' using errcode = 'no_data_found'; end if;
  select * into fp from public.fighter_private where fighter_id = p_fighter;
  return private.enqueue_email(f.org_id, null, 'fighter_id_delivery', fp.email, fp.legal_name,
    jsonb_build_object('fighter_name', f.fight_name, 'fighter_code', f.fighter_code, 'registered_at', f.registered_at),
    'fighter_id_delivery:' || f.id || ':' || to_char(now(), 'YYYYMMDDHH24MISSMS'), 'fighter', f.id);
end $$;

create or replace function public.request_missing_info(p_registration uuid, p_items jsonb, p_message text)
returns public.event_registrations language sql security definer set search_path = '' as $$
  select public.review_registration(p_registration, 'incomplete', p_message, p_items)
$$;

-- ---------- rate limiting ------------------------------------------------------------
create or replace function public.svc_rate_limit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
        v_hits integer;
begin
  insert into public.rate_limits as r (bucket, window_start, hits) values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then delete from public.rate_limits where window_start < now() - interval '1 day'; end if;
  return v_hits <= p_limit;
end $$;

-- ---------- dashboard (SECURITY INVOKER: counts only what RLS lets the caller see) ----
create or replace function public.admin_overview() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'fighters', (select count(*) from public.fighters where status = 'active'),
    'coaches', (select count(*) from public.coaches),
    'gyms', (select count(*) from public.gyms),
    'active_events', (select count(*) from public.events where status not in ('draft', 'completed', 'cancelled')),
    'pending_registrations', (select count(*) from public.event_registrations where status in ('submitted', 'under_review', 'incomplete')),
    'fighters_by_weight_class', coalesce((select jsonb_agg(x) from (
        select w.name, w.division, count(*) as n from public.event_registrations er
          join public.weight_classes w on w.id = er.preferred_weight_class_id
         where er.status = 'approved' group by w.name, w.division, w.max_g order by w.division, w.max_g) x), '[]'::jsonb),
    'open_suggestions', (select count(*) from public.matchmaking_suggestions where status = 'open'
                           and classification in ('strong_candidate', 'possible_candidate')),
    'outstanding_offers', (select count(*) from public.bouts where status in ('offer_sent', 'awaiting_responses', 'accepted_one')),
    'accepted_offers', (select count(*) from public.bouts where status = 'accepted_both'),
    'declined_offers', (select count(*) from public.bouts where status in ('declined', 'expired')),
    'confirmed_bouts', (select count(*) from public.bouts where status = 'confirmed'),
    'email_failures', (select count(*) from public.email_logs where status = 'failed'),
    'upcoming_events', coalesce((select jsonb_agg(x) from (
        select id, name, slug, starts_at, status from public.events
         where status not in ('completed', 'cancelled') order by starts_at nulls last limit 5) x), '[]'::jsonb))
$$;

-- ---------- privileges ---------------------------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema private to service_role;
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
                          public.my_access(), public.verify_coach(uuid, public.verification_status, text),
                          public.merge_fighters(uuid, uuid, text), public.announce_event(uuid, text),
                          public.resend_offer_email(uuid), public.retry_email(uuid), public.resend_email(uuid),
                          public.resend_fighter_confirmation(uuid), public.request_missing_info(uuid, jsonb, text),
                          public.admin_overview()
  to authenticated;
