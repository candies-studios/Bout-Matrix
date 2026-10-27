-- 0014 — "Unmatched fighters": ready fighters who appear in no suggestion, with the reason.
-- Computed during the same automatic refresh as the suggestions and returned by get_match_suggestions.
-- Reason = the rule that blocks the closest-weight opponent in their division (or "only fighter in this division").
alter table public.events add column if not exists unmatched_fighters jsonb not null default '[]'::jsonb;

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
  -- Why ready fighters ended up with no suggestion: closest blocked opponent per fighter.
  near jsonb := '{}'::jsonb;    -- fighter_id -> {diff, code, message, opponent, opponent_weight_g}
  matched jsonb := '{}'::jsonb; -- fighter_id -> true
  dismissed jsonb := '{}'::jsonb;
  blk jsonb;
  dg int;
  side jsonb; other jsonb;
  unmatched jsonb := '[]'::jsonb;
  uc jsonb;
  same_group int;
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
      if exists (select 1 from public.matchmaking_suggestions s
                  where s.event_id = p_event and s.status = 'dismissed'
                    and s.fighter_a_id = (a->>'fighter_id')::uuid and s.fighter_b_id = (b->>'fighter_id')::uuid) then
        dismissed := dismissed || jsonb_build_object(a->>'fighter_id', true, b->>'fighter_id', true);
        continue;
      end if;
      ev := private.evaluate_pair(a, b, pool->'event', pool->'rules', pool->'weight_classes');
      if ev->>'classification' = 'ineligible' then
        select iss into blk from jsonb_array_elements(ev->'issues') iss where iss->>'severity' = 'block' limit 1;
        dg := coalesce(abs((a->>'weight_g')::int - (b->>'weight_g')::int), 999999);
        foreach side in array array[a, b] loop
          other := case when side = a then b else a end;
          if not near ? (side->>'fighter_id') or (near->(side->>'fighter_id')->>'diff')::int > dg then
            near := near || jsonb_build_object(side->>'fighter_id', jsonb_build_object(
              'diff', dg, 'code', blk->>'code', 'message', blk->>'message',
              'opponent', other->>'fight_name', 'opponent_code', other->>'fighter_code', 'opponent_weight_g', other->'weight_g'));
          end if;
        end loop;
        continue;
      end if;
      matched := matched || jsonb_build_object(a->>'fighter_id', true, b->>'fighter_id', true);
      insert into public.matchmaking_suggestions (event_id, fighter_a_id, fighter_b_id, score, classification,
                                                  evaluation, rules_snapshot, generated_by)
      values (p_event, (a->>'fighter_id')::uuid, (b->>'fighter_id')::uuid, (ev->>'score')::numeric,
              (ev->>'classification')::public.match_classification, ev, pool->'rules', p_actor);
      inserted := inserted + 1;
    end loop;
  end loop;

  -- Ready fighters with no suggestion, and why.
  foreach uc in array cands loop
    continue when matched ? (uc->>'fighter_id');
    select count(*) into same_group from unnest(cands) x
     where x->>'fighter_id' <> uc->>'fighter_id'
       and (not same_div or x->>'division' = uc->>'division')
       and (not same_lvl or x->>'competition_level' = uc->>'competition_level');
    unmatched := unmatched || jsonb_build_object(
      'fighter_id', uc->>'fighter_id', 'fight_name', uc->>'fight_name', 'fighter_code', uc->>'fighter_code',
      'division', uc->>'division', 'weight_g', uc->'weight_g',
      'reason_code', case when same_group = 0 then 'alone_in_division'
                          when near ? (uc->>'fighter_id') then near->(uc->>'fighter_id')->>'code'
                          when dismissed ? (uc->>'fighter_id') then 'all_dismissed' else 'other' end,
      'reason', case when same_group = 0 then 'No other ready fighter in this division (same discipline, age group and gender).'
                     when near ? (uc->>'fighter_id') then near->(uc->>'fighter_id')->>'message'
                     when dismissed ? (uc->>'fighter_id') then 'Every possible pairing for this fighter was dismissed.'
                     else 'No compatible opponent.' end,
      'closest_opponent', case when same_group > 0 and near ? (uc->>'fighter_id') then jsonb_build_object(
          'fight_name', near->(uc->>'fighter_id')->>'opponent', 'fighter_code', near->(uc->>'fighter_id')->>'opponent_code',
          'weight_g', near->(uc->>'fighter_id')->'opponent_weight_g') end);
  end loop;

  update public.events set suggestions_stale = false, suggestions_refreshed_at = now(),
         unmatched_fighters = unmatched where id = p_event;
  return inserted;
end $$;


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
    'unmatched', coalesce(e.unmatched_fighters, '[]'::jsonb),
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

-- Recompute once so the list appears straight away.
update public.events set suggestions_stale = true;
