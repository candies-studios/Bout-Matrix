-- 0016 — Handpicked main card + bout export.
--
-- * public.set_main_card(event, bout ids in order): the chosen confirmed bouts become the main card in that
--   order (first = main event, second = co-main event); every other confirmed bout moves to the prelims
--   (early prelims stay early prelims), numbered after the main card. One transaction, one audit reason.
-- * A bout with no section now counts as prelims everywhere (before, it counted as main card).
-- * Card positions go up to 999 (large amateur events can have more than 99 bouts).
-- * public.export_event_bouts(event, statuses): one row per bout with both fighters' details, for the
--   Excel / PDF export. Event administrators only (it includes private contact details).

alter table public.bouts drop constraint if exists bouts_card_order_check;
alter table public.bouts add constraint bouts_card_order_check check (card_order between 1 and 999);

create or replace function public.set_main_card(p_event uuid, p_bouts uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  b record;
  n int := 0;
  v_main int := 0;
begin
  if not private.can_manage_event(p_event, v_uid) then perform private.raise_app('forbidden', 'Event not found.'); end if;
  if exists (select 1 from unnest(coalesce(p_bouts, '{}')) x(id)
              where not exists (select 1 from public.bouts bt where bt.id = x.id and bt.event_id = p_event
                                   and bt.status in ('confirmed', 'completed'))) then
    perform private.raise_app('invalid', 'Only confirmed bouts of this event can be put on the main card.');
  end if;
  if cardinality(coalesce(p_bouts, '{}')) <> (select count(distinct x) from unnest(coalesce(p_bouts, '{}')) x) then
    perform private.raise_app('invalid', 'A bout can only appear once on the main card.');
  end if;

  perform 1 from public.events where id = p_event for update;
  perform private.set_context(v_uid, 'user', 'main card set (' || cardinality(coalesce(p_bouts, '{}')) || ' bouts)');

  -- Remember the current order of the rest, then clear positions so renumbering cannot collide.
  create temp table if not exists _card_rest (id uuid, seg text, pos bigint) on commit drop;
  truncate _card_rest;
  insert into _card_rest
  select bt.id, bt.card_segment, row_number() over (order by bt.card_order nulls last, bt.created_at)
    from public.bouts bt
   where bt.event_id = p_event and bt.status in ('confirmed', 'completed') and not (bt.id = any(coalesce(p_bouts, '{}')));
  update public.bouts set card_order = null where event_id = p_event and card_order is not null;

  for b in select x.id, x.ord from unnest(coalesce(p_bouts, '{}')) with ordinality x(id, ord) order by x.ord loop
    n := n + 1;
    update public.bouts set card_segment = 'main_card', card_order = n where id = b.id;
  end loop;
  v_main := n;
  -- Prelims first, then early prelims, each keeping its previous relative order.
  for b in select id, seg from _card_rest order by (coalesce(seg, '') = 'early_prelims'), pos loop
    n := n + 1;
    update public.bouts set card_segment = case when b.seg = 'early_prelims' then 'early_prelims' else 'prelims' end,
                            card_order = n
     where id = b.id;
  end loop;
  return jsonb_build_object('main_card', v_main, 'total', n);
end $$;

create or replace function public.export_event_bouts(p_event uuid, p_statuses text[] default array['confirmed', 'completed'])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_manage_event(p_event, auth.uid()) then perform private.raise_app('forbidden', 'Event not found.'); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'bout_code', bt.bout_code, 'status', bt.status, 'card_order', bt.card_order,
      'card_segment', coalesce(bt.card_segment, 'prelims'), 'is_published', bt.is_published,
      'weight_class', w.name, 'weight_limit_g', w.max_g, 'contracted_weight_g', bt.contracted_weight_g,
      'rounds', bt.rounds, 'round_minutes', bt.round_minutes,
      'division', coalesce(ra.division, rb.division), 'event_name', e.name,
      'red', private.export_fighter(bt.fighter_a_id, p_event, e.starts_at),
      'blue', private.export_fighter(bt.fighter_b_id, p_event, e.starts_at))
      order by (coalesce(bt.card_segment, 'prelims') <> 'main_card'), bt.card_order nulls last, bt.created_at)
      from public.bouts bt
      join public.events e on e.id = bt.event_id
      left join public.weight_classes w on w.id = bt.weight_class_id
      left join public.event_registrations ra on ra.fighter_id = bt.fighter_a_id and ra.event_id = bt.event_id
      left join public.event_registrations rb on rb.fighter_id = bt.fighter_b_id and rb.event_id = bt.event_id
     where bt.event_id = p_event and bt.status::text = any(p_statuses)), '[]'::jsonb);
end $$;

create or replace function private.export_fighter(p_fighter uuid, p_event uuid, p_on timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'name', f.fight_name, 'legal_name', fp.legal_name, 'fighter_code', f.fighter_code,
    'gym', g.name, 'city', coalesce(fp.city, f.hometown), 'country', coalesce(fp.country, f.country),
    'record', (select r.wins || '-' || r.losses || '-' || r.draws from public.fighter_records r
                where r.fighter_id = f.id order by (r.kind = 'verified') desc limit 1),
    'record_verified', exists (select 1 from public.fighter_records r where r.fighter_id = f.id and r.kind = 'verified'),
    'weight_g', er.declared_weight_g,
    'age', extract(year from age(coalesce(p_on, now())::date, fp.date_of_birth))::int,
    'date_of_birth', fp.date_of_birth,
    'phone', nullif(concat_ws(' ', fp.phone_country_code, fp.phone), ''),
    'email', case when fp.email like '%.invalid' then null else fp.email end,
    'coach', fp.coach_name_declared, 'division', er.division)
  from public.fighters f
  join public.fighter_private fp on fp.fighter_id = f.id
  left join public.gyms g on g.id = f.gym_id
  left join public.event_registrations er on er.fighter_id = f.id and er.event_id = p_event
  where f.id = p_fighter
$$;

revoke all on function public.set_main_card(uuid, uuid[]), public.export_event_bouts(uuid, text[]),
  private.export_fighter(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.set_main_card(uuid, uuid[]), public.export_event_bouts(uuid, text[]) to authenticated, service_role;
grant execute on function private.export_fighter(uuid, uuid, timestamptz) to service_role;
