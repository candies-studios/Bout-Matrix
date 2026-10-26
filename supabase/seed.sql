-- Synthetic development data. Every person below is fictional. Do not load into production.
-- Admin users are NOT created here; see docs/ADMIN_BOOTSTRAP.md.

insert into public.organizations (id, name, slug, fighter_id_prefix, contact_email, branding)
values ('00000000-0000-4000-8000-000000000001', 'Demo Fight Promotions', 'demo', 'WDS', 'ops@example.com',
        '{"primary_color": "#DC2626"}')
on conflict (id) do nothing;

-- Organisation weight-class templates (Unified Rules limits, converted exactly from lb).
insert into public.weight_classes (org_id, event_id, name, division, min_g, max_g, allowed_diff_g, sort_order)
select '00000000-0000-4000-8000-000000000001', null, v.name, v.division,
       case when v.min_lb is null then null else round(v.min_lb * 453.59237)::int end,
       round(v.max_lb * 453.59237)::int, round(v.diff_lb * 453.59237)::int, v.sort
from (values
  ('Flyweight',         'men',   null::numeric, 125::numeric, 4::numeric, 1),
  ('Bantamweight',      'men',   125, 135, 4, 2),
  ('Featherweight',     'men',   135, 145, 5, 3),
  ('Lightweight',       'men',   145, 155, 5, 4),
  ('Welterweight',      'men',   155, 170, 6, 5),
  ('Middleweight',      'men',   170, 185, 7, 6),
  ('Light Heavyweight', 'men',   185, 205, 8, 7),
  ('Heavyweight',       'men',   205, 265, 20, 8),
  ('Strawweight',       'women', null, 115, 4, 1),
  ('Flyweight',         'women', 115, 125, 4, 2),
  ('Bantamweight',      'women', 125, 135, 4, 3),
  ('Featherweight',     'women', 135, 145, 5, 4)
) as v(name, division, min_lb, max_lb, diff_lb, sort)
on conflict do nothing;

insert into public.matchmaking_rules (org_id, event_id, config)
values ('00000000-0000-4000-8000-000000000001', null, '{
  "weights": {"weight": 30, "experience": 25, "record": 20, "age": 10, "skill": 15},
  "max_weight_diff_g": 4536,
  "require_same_division": true,
  "require_same_competition_level": true,
  "max_experience_gap_soft": 3,
  "max_experience_gap_hard": 8,
  "max_age_gap_years_soft": 8,
  "weight_stale_after_days": 30,
  "require_verified_record": false,
  "allow_rematch": false,
  "strong_threshold": 75,
  "possible_threshold": 55
}')
on conflict do nothing;

-- A demo event with its own copy of the templates.
insert into public.events (id, org_id, slug, name, promotion, description, status, is_public,
                           registration_opens_at, registration_closes_at, starts_at, timezone,
                           venue_name, venue_city, venue_country, eligibility)
values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001',
        'demo-fight-night-1', 'Demo Fight Night 1', 'Demo Fight Promotions',
        'Synthetic event for local development.', 'registration_open', true,
        now() - interval '1 day', now() + interval '30 days', null, 'Asia/Kolkata',
        null, 'Mumbai', 'India',
        '{"min_age": 18, "max_age": 40, "divisions": ["men", "women"],
          "competition_levels": ["amateur"], "require_clearance": true, "required_documents": []}')
on conflict (id) do nothing;

insert into public.weight_classes (org_id, event_id, name, division, min_g, max_g, allowed_diff_g, sort_order)
select org_id, '00000000-0000-4000-8000-0000000000e1', name, division, min_g, max_g, allowed_diff_g, sort_order
  from public.weight_classes where event_id is null and org_id = '00000000-0000-4000-8000-000000000001'
on conflict do nothing;

insert into public.gyms (id, org_id, name, city, country, verification_status)
values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Iron Tide MMA', 'Mumbai', 'India', 'verified'),
       ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000001', 'Northgate Combat Club', 'Pune', 'India', 'verified')
on conflict (id) do nothing;

-- Eight fictional fighters with registrations for the demo event.
with src(fight_name, legal_name, dob, email, gym, division, kg, w, l, d) as (values
  ('Arjun "Anvil" Rao',    'Arjun Rao Test',    date '1998-03-14', 'arjun.test@example.com',  'a1', 'men', 69.8, 4, 1, 0),
  ('Kabir Sen',            'Kabir Sen Test',    date '1997-07-02', 'kabir.test@example.com',  'a2', 'men', 70.1, 3, 2, 0),
  ('Dev Malhotra',         'Dev Malhotra Test', date '2000-11-21', 'dev.test@example.com',    'a1', 'men', 77.0, 1, 0, 0),
  ('Rohan Iyer',           'Rohan Iyer Test',   date '1999-01-09', 'rohan.test@example.com',  'a2', 'men', 76.4, 0, 0, 0),
  ('Vikram Shah',          'Vikram Shah Test',  date '1995-05-30', 'vikram.test@example.com', 'a1', 'men', 65.5, 6, 2, 1),
  ('Imran Qureshi',        'Imran Q Test',      date '1996-09-17', 'imran.test@example.com',  'a2', 'men', 65.2, 5, 3, 0),
  ('Meera Pillai',         'Meera Pillai Test', date '2001-02-11', 'meera.test@example.com',  'a1', 'women', 56.0, 2, 1, 0),
  ('Sana Kapoor',          'Sana Kapoor Test',  date '1999-12-05', 'sana.test@example.com',   'a2', 'women', 56.5, 2, 0, 0)
), ins as (
  insert into public.fighters (org_id, fight_name, gym_id, division, competition_level, country)
  select '00000000-0000-4000-8000-000000000001', s.fight_name,
         ('00000000-0000-4000-8000-0000000000' || s.gym)::uuid, s.division, 'amateur', 'India'
    from src s
  returning id, fight_name
), priv as (
  insert into public.fighter_private (fighter_id, legal_name, date_of_birth, email, consent_at, consent_version)
  select i.id, s.legal_name, s.dob, s.email, now(), 'v1' from ins i join src s using (fight_name)
), rec as (
  insert into public.fighter_records (fighter_id, kind, wins, losses, draws)
  select i.id, 'self_reported', s.w, s.l, s.d from ins i join src s using (fight_name)
)
insert into public.event_registrations (event_id, fighter_id, status, submitted_via, declared_weight_g,
                                        weight_unit_entered, weight_recorded_at, division, competition_level,
                                        clearance_status, submitted_at)
select '00000000-0000-4000-8000-0000000000e1', i.id, 'approved', 'self', round(s.kg * 1000)::int, 'kg', now(),
       s.division, 'amateur', 'cleared', now()
  from ins i join src s using (fight_name);
