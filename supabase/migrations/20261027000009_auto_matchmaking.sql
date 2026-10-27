-- =====================================================================================
-- 0009 · Automatic matchmaking inside the database (no Edge Function needed)
--
--  * private.evaluate_pair  — SQL port of supabase/functions/_shared/domain/matchmaking.ts
--    (parity is enforced by tests/db/matchmaking-parity.test.ts on randomised pairs).
--  * Suggestions refresh automatically: any change to registrations, records, fighters,
--    weight classes, rules or bouts marks the event stale; the next read (admin page,
--    dashboard, or the 5-minute cron job) recomputes it.
--  * public.get_match_suggestions(event)  — what the Matchmaking page shows.
--  * public.create_bout(p)                — admin turns a suggestion into a draft bout; the
--    pairing is re-evaluated on the server (the browser never supplies the evaluation).
-- A human still approves every bout; nothing is booked automatically.
-- =====================================================================================

alter table public.events add column if not exists suggestions_stale boolean not null default true;
alter table public.events add column if not exists suggestions_refreshed_at timestamptz;

-- ---------- helpers ----------------------------------------------------------------
create or replace function private.clamp01(x double precision) returns double precision
language sql immutable set search_path = '' as $$ select greatest(0::double precision, least(1::double precision, x)) $$;

-- Grams → "x.y" kg, rounded half-up on whole grams (identical to kg1() in matchmaking.ts).
create or replace function private.kg1(g integer) returns text
language sql immutable set search_path = '' as $$ select to_char(floor(g / 100.0 + 0.5) / 10, 'FM9999990.0') $$;

create or replace function private.age_on(p_dob date, p_on timestamptz) returns integer
language sql immutable set search_path = '' as $$
  select case when p_dob is null then null else
    extract(year from (p_on at time zone 'UTC'))::int - extract(year from p_dob)::int
    - case when (extract(month from (p_on at time zone 'UTC')), extract(day from (p_on at time zone 'UTC')))
                < (extract(month from p_dob), extract(day from p_dob)) then 1 else 0 end
  end
$$;

create or replace function private.fmt_record(r jsonb) returns text
language sql immutable set search_path = '' as $$
  select (r->>'wins') || '-' || (r->>'losses') || '-' || (r->>'draws')
         || case when coalesce((r->>'no_contests')::int, 0) > 0 then ' (' || (r->>'no_contests') || ' NC)' else '' end
         || case when r->>'kind' = 'verified' then '' else '*' end
$$;

create or replace function private.win_rate(r jsonb) returns double precision
language sql immutable set search_path = '' as $$
  select case when r is null or jsonb_typeof(r) = 'null' then null
              when (r->>'wins')::int + (r->>'losses')::int + (r->>'draws')::int = 0 then null
              else ((r->>'wins')::double precision + (r->>'draws')::double precision / 2)
                   / ((r->>'wins')::int + (r->>'losses')::int + (r->>'draws')::int) end
$$;

create or replace function private.total_fights(r jsonb) returns integer
language sql immutable set search_path = '' as $$
  select case when r is null or jsonb_typeof(r) = 'null' then null
              else coalesce((r->>'total_fights')::int,
                            (r->>'wins')::int + (r->>'losses')::int + (r->>'draws')::int + (r->>'no_contests')::int) end
$$;

create or replace function private.resolve_rules(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
           'weight_stale_after_days', 30, 'max_weight_diff_g', 4536, 'require_same_division', true,
           'require_same_competition_level', true, 'max_experience_gap_soft', 3, 'max_experience_gap_hard', 8,
           'max_age_gap_years_soft', 8, 'require_verified_record', false, 'allow_rematch', false,
           'strong_threshold', 75, 'possible_threshold', 55)
         || coalesce(p, '{}'::jsonb) - 'weights'
         || jsonb_build_object('weights',
              '{"weight": 30, "experience": 25, "record": 20, "age": 10, "skill": 15}'::jsonb
              || coalesce(p->'weights', '{}'::jsonb))
$$;

-- ---------- the engine -------------------------------------------------------------
create or replace function private.evaluate_pair(a jsonb, b jsonb, ctx jsonb, p_rules jsonb, p_classes jsonb,
                                                 p_now timestamptz default now())
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  r jsonb := private.resolve_rules(p_rules);
  issues jsonb := '[]'::jsonb;
  missing jsonb := '[]'::jsonb;
  expl jsonb := '[]'::jsonb;
  c jsonb; side text; nm text;
  ev_date timestamptz := nullif(ctx->>'starts_at', '')::timestamptz;
  age_date timestamptz;
  age_a int; age_b int; age int;
  min_age int := (ctx->'eligibility'->>'min_age')::int;
  max_age int := (ctx->'eligibility'->>'max_age')::int;
  req_clear boolean := coalesce((ctx->'eligibility'->>'require_clearance')::boolean, false);
  days int;
  wa int := nullif(a->>'weight_g', '')::int;
  wb int := nullif(b->>'weight_g', '')::int;
  diff int; heavier int; lim int;
  wc jsonb;
  proposed jsonb := null;
  w_score double precision; w_detail text := 'Weight missing';
  e_score double precision; e_detail text := 'Fight record missing';
  r_score double precision; r_detail text := 'Fight record missing';
  a_score double precision; a_detail text := 'Age unknown';
  s_score double precision; s_detail text := 'Skill level not provided';
  ta int; tb int; gap int;
  ra double precision; rb double precision;
  g int;
  skill jsonb := '{"novice":0,"intermediate":1,"advanced":2,"elite":3}';
  num double precision := 0; den double precision := 0;
  k text; wt double precision; sc double precision;
  score double precision;
  cls text;
begin
  -- 1. eligibility & availability
  if a->>'fighter_id' = b->>'fighter_id' then
    issues := issues || jsonb_build_object('severity','block','code','same_fighter','message','A fighter cannot be matched with themselves.');
  end if;
  foreach side in array array['A','B'] loop
    c := case side when 'A' then a else b end; nm := c->>'fight_name';
    if c->>'registration_status' <> 'approved' then
      issues := issues || jsonb_build_object('severity','block','code','registration_not_approved','fighter',side,
        'message', nm || '''s registration is ' || regexp_replace(c->>'registration_status', '_', ' ') || ', not approved.');
    end if;
    if not coalesce((c->>'is_available')::boolean, false) then
      issues := issues || jsonb_build_object('severity','block','code','unavailable','fighter',side,'message', nm || ' is marked unavailable.');
    end if;
  end loop;

  -- 2. division & level
  if (r->>'require_same_division')::boolean and a->>'division' <> b->>'division' then
    issues := issues || jsonb_build_object('severity','block','code','division_mismatch',
      'message', 'Different competition divisions (' || (a->>'division') || ' vs ' || (b->>'division') || ').');
  end if;
  if (r->>'require_same_competition_level')::boolean and a->>'competition_level' <> b->>'competition_level' then
    issues := issues || jsonb_build_object('severity','block','code','level_mismatch',
      'message', 'Different competition levels (' || (a->>'competition_level') || ' vs ' || (b->>'competition_level') || ').');
  end if;

  -- 4. age
  if ev_date is null then
    issues := issues || jsonb_build_object('severity','info','code','event_date_tba','message','Event date is TBA; ages are calculated as of today.');
  end if;
  age_date := coalesce(ev_date, p_now);
  age_a := private.age_on(nullif(a->>'date_of_birth','')::date, age_date);
  age_b := private.age_on(nullif(b->>'date_of_birth','')::date, age_date);
  foreach side in array array['A','B'] loop
    c := case side when 'A' then a else b end; nm := c->>'fight_name';
    age := case side when 'A' then age_a else age_b end;
    if age is null then
      missing := missing || to_jsonb(nm || ': date of birth');
      issues := issues || jsonb_build_object('severity','review','code','age_unknown','fighter',side,'message', nm || '''s age cannot be determined.');
      continue;
    end if;
    if min_age is not null and age < min_age then
      issues := issues || jsonb_build_object('severity','block','code','too_young','fighter',side,
        'message', nm || ' will be ' || age || '; minimum age is ' || min_age || '.');
    end if;
    if max_age is not null and age > max_age then
      issues := issues || jsonb_build_object('severity','block','code','too_old','fighter',side,
        'message', nm || ' will be ' || age || '; maximum age is ' || max_age || '.');
    end if;
  end loop;

  -- 9. clearance
  foreach side in array array['A','B'] loop
    c := case side when 'A' then a else b end; nm := c->>'fight_name';
    if c->>'clearance_status' = 'not_cleared' then
      issues := issues || jsonb_build_object('severity','block','code','not_cleared','fighter',side,'message', nm || ' has not been cleared to compete.');
    elsif req_clear and c->>'clearance_status' <> 'cleared' then
      issues := issues || jsonb_build_object('severity','review','code','clearance_pending','fighter',side,'message', nm || '''s clearance is still pending.');
    end if;
  end loop;

  -- 10–11. rematches & conflicts
  if not (r->>'allow_rematch')::boolean
     and (coalesce(a->'previous_opponents','[]') ? (b->>'fighter_id') or coalesce(b->'previous_opponents','[]') ? (a->>'fighter_id')) then
    issues := issues || jsonb_build_object('severity','block','code','rematch','message','These fighters have met before and rematches are not allowed.');
  end if;
  foreach side in array array['A','B'] loop
    c := case side when 'A' then a else b end; nm := c->>'fight_name';
    if coalesce((c->>'active_bout_in_event')::boolean, false) then
      issues := issues || jsonb_build_object('severity','block','code','conflict_same_event','fighter',side,'message', nm || ' already has an active bout at this event.');
    end if;
    if coalesce((c->>'active_bouts_elsewhere')::int, 0) > 0 then
      issues := issues || jsonb_build_object('severity','info','code','active_elsewhere','fighter',side,
        'message', nm || ' has ' || (c->>'active_bouts_elsewhere') || ' active bout(s) at other events — check dates.');
    end if;
  end loop;
  if nullif(a->>'gym_id','') is not null and a->>'gym_id' = b->>'gym_id' then
    issues := issues || jsonb_build_object('severity','review','code','same_gym','message','Both fighters train at ' || coalesce(a->>'gym_name', 'the same gym') || '.');
  end if;

  -- 3. weight
  foreach side in array array['A','B'] loop
    c := case side when 'A' then a else b end; nm := c->>'fight_name';
    if nullif(c->>'weight_g','') is null then
      missing := missing || to_jsonb(nm || ': current weight');
      issues := issues || jsonb_build_object('severity','review','code','weight_missing','fighter',side,'message', nm || ' has no recorded weight.');
      continue;
    end if;
    days := case when nullif(c->>'weight_recorded_at','') is null then null
                 else greatest(0, floor(extract(epoch from (p_now - (c->>'weight_recorded_at')::timestamptz)) / 86400)::int) end;
    if days is null or days > (r->>'weight_stale_after_days')::int then
      issues := issues || jsonb_build_object('severity','review','code','weight_stale','fighter',side,
        'message', nm || '''s weight is ' || case when days is null then 'undated' else days || ' days old' end || '.');
    end if;
  end loop;
  if wa is not null and wb is not null then
    diff := abs(wa - wb);
    heavier := greatest(wa, wb);
    select x into wc from jsonb_array_elements(coalesce(p_classes, '[]')) x
     where (x->>'division' is null or a->>'division' is null or x->>'division' = a->>'division')
       and (x->>'min_g' is null or heavier > (x->>'min_g')::int) and heavier <= (x->>'max_g')::int
     order by (x->>'max_g')::int limit 1;
    lim := least((r->>'max_weight_diff_g')::int, coalesce((wc->>'allowed_diff_g')::int, (r->>'max_weight_diff_g')::int));
    if wc is not null then proposed := jsonb_build_object('id', wc->>'id', 'name', wc->>'name');
    elsif jsonb_array_length(coalesce(p_classes, '[]')) > 0 then
      issues := issues || jsonb_build_object('severity','review','code','no_weight_class','message','No configured weight class fits the heavier fighter.');
    end if;
    if diff > lim then
      issues := issues || jsonb_build_object('severity','block','code','weight_gap',
        'message', 'Weight difference ' || private.kg1(diff) || ' kg exceeds the permitted ' || private.kg1(lim) || ' kg.');
    end if;
    w_score := private.clamp01(1 - diff::double precision / greatest(lim, 1));
    w_detail := private.kg1(diff) || ' kg apart (limit ' || private.kg1(lim) || ' kg)';
    expl := expl || to_jsonb('Weights ' || w_detail || coalesce(', proposed ' || (proposed->>'name'), '') || '.');
  end if;

  -- 5–6. experience & record
  ta := private.total_fights(a->'record'); tb := private.total_fights(b->'record');
  foreach side in array array['A','B'] loop
    c := case side when 'A' then a else b end; nm := c->>'fight_name';
    if c->'record' is null or jsonb_typeof(c->'record') = 'null' then
      missing := missing || to_jsonb(nm || ': fight record');
      issues := issues || jsonb_build_object('severity','review','code','record_missing','fighter',side,'message', nm || ' has no fight record.');
    elsif c->'record'->>'kind' <> 'verified' then
      issues := issues || jsonb_build_object('severity', case when (r->>'require_verified_record')::boolean then 'review' else 'info' end,
        'code','record_unverified','fighter',side,'message', nm || '''s record is self-reported.');
    end if;
  end loop;
  if ta is not null and tb is not null then
    gap := abs(ta - tb);
    if gap > (r->>'max_experience_gap_hard')::int then
      issues := issues || jsonb_build_object('severity','block','code','experience_gap',
        'message', 'Experience gap of ' || gap || ' fights exceeds the limit of ' || (r->>'max_experience_gap_hard') || '.');
    elsif gap > (r->>'max_experience_gap_soft')::int then
      issues := issues || jsonb_build_object('severity','review','code','experience_gap_soft','message', 'Experience gap of ' || gap || ' fights.');
    end if;
    e_score := private.clamp01(1 - gap::double precision / greatest((r->>'max_experience_gap_hard')::int, 1));
    e_detail := ta || ' vs ' || tb || ' fights';
    expl := expl || to_jsonb('Experience ' || e_detail || '.');
    ra := private.win_rate(a->'record'); rb := private.win_rate(b->'record');
    r_score := private.clamp01(case when ra is null and rb is null then 1 else 1 - abs(coalesce(ra, 0.5) - coalesce(rb, 0.5)) end);
    r_detail := private.fmt_record(a->'record') || ' vs ' || private.fmt_record(b->'record');
    expl := expl || to_jsonb('Records ' || r_detail || '.');
  end if;

  -- age & skill components
  if age_a is not null and age_b is not null then
    g := abs(age_a - age_b);
    a_score := private.clamp01(1 - g::double precision / ((r->>'max_age_gap_years_soft')::double precision * 2));
    a_detail := age_a || ' vs ' || age_b || ' years';
    if g > (r->>'max_age_gap_years_soft')::int then
      issues := issues || jsonb_build_object('severity','review','code','age_gap','message', 'Age gap of ' || g || ' years.');
    end if;
  end if;
  if nullif(a->>'skill_level','') is not null and nullif(b->>'skill_level','') is not null then
    g := abs((skill->>(a->>'skill_level'))::int - (skill->>(b->>'skill_level'))::int);
    s_score := 1 - g::double precision / 3;
    s_detail := (a->>'skill_level') || ' vs ' || (b->>'skill_level');
    if g >= 2 then
      issues := issues || jsonb_build_object('severity','review','code','skill_gap','message', 'Skill levels differ substantially (' || s_detail || ').');
    end if;
  end if;
  if nullif(a->>'primary_style','') is not null and nullif(b->>'primary_style','') is not null then
    expl := expl || to_jsonb('Styles: ' || (a->>'primary_style') || ' vs ' || (b->>'primary_style') || '.');
  end if;

  -- score: weighted mean over computable components, in the same order as the TypeScript engine
  -- jsonb does not keep key order, so iterate in the engine's fixed order.
  foreach k in array array['weight', 'experience', 'record', 'age', 'skill'] loop
    wt := coalesce((r->'weights'->>k)::double precision, 0);
    sc := case k when 'weight' then w_score when 'experience' then e_score when 'record' then r_score
                 when 'age' then a_score when 'skill' then s_score end;
    if sc is not null and wt > 0 then num := num + sc * wt; den := den + wt; end if;
  end loop;
  score := case when den > 0 and w_score is not null and e_score is not null
                then floor((num / den) * 1000 + 0.5) / 10 end;

  cls := case
    when exists (select 1 from jsonb_array_elements(issues) i where i->>'severity' = 'block') then 'ineligible'
    when exists (select 1 from jsonb_array_elements(issues) i where i->>'severity' = 'review') or score is null then 'requires_review'
    when score >= (r->>'strong_threshold')::double precision then 'strong_candidate'
    when score >= (r->>'possible_threshold')::double precision then 'possible_candidate'
    else 'requires_review' end;
  if score is null then expl := expl || to_jsonb('Not enough verified information to score this pairing.'::text); end if;

  return jsonb_build_object(
    'fighter_a_id', a->>'fighter_id', 'fighter_b_id', b->>'fighter_id',
    'score', score, 'classification', cls, 'proposed_weight_class', proposed, 'weight_diff_g', diff,
    'components', jsonb_build_object(
      'weight', jsonb_build_object('score', w_score, 'detail', w_detail),
      'experience', jsonb_build_object('score', e_score, 'detail', e_detail),
      'record', jsonb_build_object('score', r_score, 'detail', r_detail),
      'age', jsonb_build_object('score', a_score, 'detail', a_detail),
      'skill', jsonb_build_object('score', s_score, 'detail', s_detail)),
    'explanation', expl, 'missing', missing, 'issues', issues);
end $$;

-- ---------- event pool (no permission check; callers check) ------------------------
create or replace function private.matchmaking_pool(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e public.events;
begin
  select * into e from public.events where id = p_event;
  if not found then return null; end if;
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

-- Existing service function now delegates to the shared pool builder.
create or replace function public.svc_matchmaking_pool(p_actor uuid, p_event uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_matchmake_event(p_event, p_actor) then perform private.raise_app('forbidden', 'Event not found.'); end if;
  return private.matchmaking_pool(p_event);
end $$;

-- ---------- recompute suggestions for one event ------------------------------------
create or replace function private.refresh_event_suggestions(p_event uuid, p_actor uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  pool jsonb := private.matchmaking_pool(p_event);
  cands jsonb[];
  rules jsonb;
  same_div boolean; same_lvl boolean;
  i int; j int; n int;
  ev jsonb;
  inserted int := 0;
  a jsonb; b jsonb;
begin
  if pool is null then return 0; end if;
  perform 1 from public.events where id = p_event for update;   -- one refresh per event at a time
  rules := private.resolve_rules(pool->'rules');
  same_div := (rules->>'require_same_division')::boolean;
  same_lvl := (rules->>'require_same_competition_level')::boolean;

  -- Only fighters who could possibly be matched (others are always "ineligible", which is never shown).
  select coalesce(array_agg(c order by (c->>'weight_g')::int nulls last), '{}') into cands
    from jsonb_array_elements(pool->'candidates') c
   where c->>'registration_status' = 'approved' and (c->>'is_available')::boolean
     and c->>'clearance_status' <> 'not_cleared' and not (c->>'active_bout_in_event')::boolean;
  n := coalesce(array_length(cands, 1), 0);

  delete from public.matchmaking_suggestions where event_id = p_event and status in ('open', 'stale');

  for i in 1 .. n loop
    for j in i + 1 .. n loop
      a := cands[i]; b := cands[j];
      continue when same_div and a->>'division' <> b->>'division';
      continue when same_lvl and a->>'competition_level' <> b->>'competition_level';
      -- keep the pair order canonical (fighter_a_id < fighter_b_id)
      if (a->>'fighter_id') > (b->>'fighter_id') then a := cands[j]; b := cands[i]; end if;
      continue when exists (select 1 from public.matchmaking_suggestions s
                             where s.event_id = p_event and s.status = 'dismissed'
                               and s.fighter_a_id = (a->>'fighter_id')::uuid and s.fighter_b_id = (b->>'fighter_id')::uuid);
      ev := private.evaluate_pair(a, b, pool->'event', pool->'rules', pool->'weight_classes');
      continue when ev->>'classification' = 'ineligible';
      insert into public.matchmaking_suggestions (event_id, fighter_a_id, fighter_b_id, score, classification,
                                                  evaluation, rules_snapshot, generated_by)
      values (p_event, (a->>'fighter_id')::uuid, (b->>'fighter_id')::uuid, (ev->>'score')::numeric,
              (ev->>'classification')::public.match_classification, ev, pool->'rules', p_actor);
      inserted := inserted + 1;
    end loop;
  end loop;

  update public.events set suggestions_stale = false, suggestions_refreshed_at = now() where id = p_event;
  return inserted;
end $$;

-- ---------- what admins see -------------------------------------------------------------
create or replace function public.get_match_suggestions(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.events;
begin
  select * into e from public.events where id = p_event;
  if not found or not private.can_matchmake_event(p_event) then
    raise exception 'event not found' using errcode = 'no_data_found';
  end if;
  if e.suggestions_stale or e.suggestions_refreshed_at is null or e.suggestions_refreshed_at < now() - interval '1 hour' then
    perform private.refresh_event_suggestions(p_event, auth.uid());
    select * into e from public.events where id = p_event;
  end if;
  return jsonb_build_object(
    'refreshed_at', e.suggestions_refreshed_at,
    'stats', (select jsonb_build_object(
        'registrants', count(*) filter (where er.status in ('submitted', 'under_review', 'approved')),
        'approved', count(*) filter (where er.status = 'approved'),
        'ready', count(*) filter (where er.status = 'approved' and er.is_available and er.clearance_status <> 'not_cleared'
                                   and not exists (select 1 from public.bout_participants bp
                                                    where bp.fighter_id = er.fighter_id and bp.event_id = p_event and bp.is_active)),
        'awaiting_review', count(*) filter (where er.status in ('submitted', 'under_review', 'incomplete')))
       from public.event_registrations er where er.event_id = p_event),
    'suggestions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'fighter_a_id', s.fighter_a_id, 'fighter_b_id', s.fighter_b_id, 'score', s.score,
        'classification', s.classification, 'evaluation', s.evaluation,
        'fighter_a', jsonb_build_object('fight_name', fa.fight_name, 'fighter_code', fa.fighter_code,
                       'weight_g', ra.declared_weight_g, 'division', ra.division),
        'fighter_b', jsonb_build_object('fight_name', fb.fight_name, 'fighter_code', fb.fighter_code,
                       'weight_g', rb.declared_weight_g, 'division', rb.division))
        order by case s.classification when 'strong_candidate' then 0 when 'possible_candidate' then 1 else 2 end,
                 s.score desc nulls last)
      from public.matchmaking_suggestions s
      join public.fighters fa on fa.id = s.fighter_a_id
      join public.fighters fb on fb.id = s.fighter_b_id
      left join public.event_registrations ra on ra.fighter_id = s.fighter_a_id and ra.event_id = p_event
      left join public.event_registrations rb on rb.fighter_id = s.fighter_b_id and rb.event_id = p_event
     where s.event_id = p_event and s.status = 'open'), '[]'::jsonb));
end $$;

-- Admin turns a suggestion into a draft bout. The pairing is re-evaluated here, on the server.
create or replace function public.create_bout(p jsonb) returns public.bouts
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_event uuid := (p->>'event_id')::uuid;
  pool jsonb;
  a jsonb; b jsonb;
  old public.bouts;
  s public.matchmaking_suggestions;
  ev jsonb;
begin
  if v_uid is null or not private.can_matchmake_event(v_event, v_uid) then
    raise exception 'event not found' using errcode = 'no_data_found';
  end if;
  if nullif(p->>'suggestion_id', '') is not null then
    select * into s from public.matchmaking_suggestions where id = (p->>'suggestion_id')::uuid;
    if not found or s.event_id <> v_event
       or least(s.fighter_a_id, s.fighter_b_id)::text <> least(p->>'fighter_a_id', p->>'fighter_b_id')
       or greatest(s.fighter_a_id, s.fighter_b_id)::text <> greatest(p->>'fighter_a_id', p->>'fighter_b_id') then
      raise exception 'suggestion does not match this pairing' using errcode = 'check_violation';
    end if;
  end if;

  pool := private.matchmaking_pool(v_event);
  select c into a from jsonb_array_elements(pool->'candidates') c where c->>'fighter_id' = p->>'fighter_a_id';
  select c into b from jsonb_array_elements(pool->'candidates') c where c->>'fighter_id' = p->>'fighter_b_id';
  if a is null or b is null then
    raise exception 'Both fighters must be registered for this event.' using errcode = 'check_violation';
  end if;
  -- A replaced bout releases its fighters (the replacement is created in the same transaction).
  if nullif(p->>'replaces_bout_id', '') is not null then
    select * into old from public.bouts where id = (p->>'replaces_bout_id')::uuid and event_id = v_event;
    if not found then raise exception 'Original bout not found in this event.' using errcode = 'check_violation'; end if;
    if a->>'fighter_id' in (old.fighter_a_id::text, old.fighter_b_id::text) then a := a || '{"active_bout_in_event": false}'; end if;
    if b->>'fighter_id' in (old.fighter_a_id::text, old.fighter_b_id::text) then b := b || '{"active_bout_in_event": false}'; end if;
  end if;

  ev := private.evaluate_pair(a, b, pool->'event', pool->'rules', pool->'weight_classes');
  return public.svc_create_bout(v_uid, (p - 'evaluation')
    || jsonb_build_object('evaluation', ev,
                          'weight_class_id', coalesce(nullif(p->>'weight_class_id', ''), ev->'proposed_weight_class'->>'id')));
end $$;

create or replace function public.dismiss_suggestion(p_suggestion uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.matchmaking_suggestions;
begin
  select * into s from public.matchmaking_suggestions where id = p_suggestion;
  if not found or not private.can_matchmake_event(s.event_id) then raise exception 'suggestion not found' using errcode = 'no_data_found'; end if;
  update public.matchmaking_suggestions set status = 'dismissed' where id = p_suggestion;
end $$;

-- Cron / dashboard: refresh every stale event.
create or replace function public.svc_refresh_stale_suggestions() returns integer
language plpgsql security definer set search_path = '' as $$
declare e record; n int := 0;
begin
  for e in select id from public.events
            where status not in ('draft', 'completed', 'cancelled')
              and (suggestions_stale or suggestions_refreshed_at is null or suggestions_refreshed_at < now() - interval '1 hour')
  loop
    perform private.refresh_event_suggestions(e.id, null);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- mark events stale when anything that affects matchmaking changes -------------
create or replace function private.mark_suggestions_stale() returns trigger
language plpgsql security definer set search_path = '' as $$
declare rec jsonb := to_jsonb(coalesce(new, old));
begin
  if tg_table_name in ('event_registrations', 'bouts') then
    update public.events set suggestions_stale = true where id = (rec->>'event_id')::uuid and not suggestions_stale;
  elsif tg_table_name in ('weight_classes', 'matchmaking_rules') then
    if rec->>'event_id' is not null then
      update public.events set suggestions_stale = true where id = (rec->>'event_id')::uuid and not suggestions_stale;
    end if;
  elsif tg_table_name in ('fighters', 'fighter_private', 'fighter_records') then
    update public.events e set suggestions_stale = true
     where not e.suggestions_stale
       and e.id in (select er.event_id from public.event_registrations er
                     where er.fighter_id = coalesce((rec->>'fighter_id')::uuid, (rec->>'id')::uuid));
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['event_registrations', 'bouts', 'weight_classes', 'matchmaking_rules',
                           'fighters', 'fighter_private', 'fighter_records'] loop
    execute format('drop trigger if exists mark_suggestions_stale on public.%I', t);
    execute format('create trigger mark_suggestions_stale after insert or update or delete on public.%I
                    for each row execute function private.mark_suggestions_stale()', t);
  end loop;
end $$;

-- Dashboard count stays fresh: refresh stale events before counting.
create or replace function public.admin_overview_fresh() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e record;
begin
  for e in select id from public.events
            where status not in ('draft', 'completed', 'cancelled') and suggestions_stale
              and private.can_matchmake_event(id)
  loop
    perform private.refresh_event_suggestions(e.id, auth.uid());
  end loop;
  return public.admin_overview();
end $$;

-- ---------- privileges & schedule ----------------------------------------------------
revoke all on function private.clamp01(double precision), private.kg1(integer), private.age_on(date, timestamptz),
  private.fmt_record(jsonb), private.win_rate(jsonb), private.total_fights(jsonb), private.resolve_rules(jsonb),
  private.evaluate_pair(jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz), private.matchmaking_pool(uuid),
  private.refresh_event_suggestions(uuid, uuid), private.mark_suggestions_stale()
  from public, anon, authenticated;
grant execute on function private.clamp01(double precision), private.kg1(integer), private.age_on(date, timestamptz),
  private.fmt_record(jsonb), private.win_rate(jsonb), private.total_fights(jsonb), private.resolve_rules(jsonb),
  private.evaluate_pair(jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz), private.matchmaking_pool(uuid),
  private.refresh_event_suggestions(uuid, uuid), private.mark_suggestions_stale()
  to service_role;

revoke all on function public.get_match_suggestions(uuid), public.create_bout(jsonb), public.dismiss_suggestion(uuid),
  public.svc_refresh_stale_suggestions(), public.admin_overview_fresh() from public, anon, authenticated;
grant execute on function public.get_match_suggestions(uuid), public.create_bout(jsonb), public.dismiss_suggestion(uuid),
  public.admin_overview_fresh() to authenticated;
grant execute on function public.get_match_suggestions(uuid), public.create_bout(jsonb), public.dismiss_suggestion(uuid),
  public.svc_refresh_stale_suggestions(), public.admin_overview_fresh() to service_role;

do $outer$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('refresh-match-suggestions', '*/5 * * * *', 'select public.svc_refresh_stale_suggestions()');
  end if;
exception when others then
  raise notice 'Could not schedule refresh-match-suggestions (%); suggestions still refresh when the page opens.', sqlerrm;
end
$outer$;

-- Every existing event starts stale so the first page view computes suggestions.
update public.events set suggestions_stale = true;
