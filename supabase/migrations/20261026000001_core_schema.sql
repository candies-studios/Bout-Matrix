-- =====================================================================================
-- 0001 · Core schema: types, organisations, access, people, events, registrations
-- =====================================================================================
-- Conventions
--   * Weights are integer grams (canonical unit). 1 lb = 453.59237 g.
--   * Emails are stored lower-cased (CHECK enforced).
--   * Every table gets RLS in migration 0004; API roles start with NO table privileges here.
-- =====================================================================================

create schema if not exists private;
revoke all on schema private from public;

-- ---------- enums ------------------------------------------------------------------
create type public.app_role as enum ('super_admin', 'org_admin', 'staff', 'coach');
create type public.event_role as enum ('event_admin', 'matchmaker');
create type public.event_status as enum (
  'draft', 'registration_open', 'registration_closed', 'matchmaking',
  'fight_card_pending', 'published', 'completed', 'cancelled');
create type public.registration_status as enum (
  'draft', 'submitted', 'under_review', 'approved', 'rejected', 'incomplete');
create type public.verification_status as enum ('pending', 'verified', 'rejected');
create type public.link_status as enum ('pending', 'approved', 'rejected');
create type public.clearance_status as enum ('not_required', 'pending', 'cleared', 'not_cleared');
create type public.competition_level as enum ('amateur', 'semi_pro', 'professional');
create type public.fighter_status as enum ('active', 'inactive', 'merged', 'retired');
create type public.record_kind as enum ('self_reported', 'verified');
create type public.skill_level as enum ('novice', 'intermediate', 'advanced', 'elite');

-- ---------- utilities --------------------------------------------------------------
create or replace function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- organisations & access ------------------------------------------------
create table public.organizations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) between 2 and 120),
  slug              text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  fighter_id_prefix text not null default 'WDS' check (fighter_id_prefix ~ '^[A-Z0-9]{2,8}$'),
  branding          jsonb not null default '{}'::jsonb,
  contact_email     text check (contact_email = lower(contact_email)),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.user_profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  org_id     uuid references public.organizations (id) on delete set null,
  full_name  text check (length(full_name) <= 120),
  email      text check (email = lower(email)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  org_id     uuid not null references public.organizations (id) on delete cascade,
  role       public.app_role not null,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, org_id, role)
);
create index on public.user_roles (org_id, role);

-- Monotonic, never-decremented counters (fighter IDs, bout codes, event codes).
create table public.id_counters (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  kind       text not null check (kind in ('fighter', 'bout', 'event')),
  last_value bigint not null default 0 check (last_value >= 0),
  primary key (org_id, kind)
);

create table public.system_settings (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  key        text not null check (key ~ '^[a-z0-9_.]+$'),
  value      jsonb not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, key)
);

-- ---------- gyms & coaches --------------------------------------------------------
create table public.gyms (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  name                text not null check (length(trim(name)) between 2 and 120),
  city                text check (length(city) <= 80),
  country             text check (length(country) <= 80),
  website             text check (length(website) <= 200),
  verification_status public.verification_status not null default 'pending',
  is_public           boolean not null default true,  -- may the gym name appear on public cards
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index gyms_org_name_city_uq on public.gyms (org_id, lower(name), lower(coalesce(city, '')));

create table public.coaches (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations (id) on delete cascade,
  user_id                  uuid unique references auth.users (id) on delete set null,
  gym_id                   uuid references public.gyms (id) on delete set null,
  full_name                text not null check (length(trim(full_name)) between 2 and 120),
  email                    text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone_country_code       text check (phone_country_code ~ '^\+[0-9]{1,4}$'),
  phone                    text check (phone ~ '^[0-9 ()-]{5,20}$'),
  city                     text check (length(city) <= 80),
  country                  text check (length(country) <= 80),
  coaching_experience_years smallint check (coaching_experience_years between 0 and 80),
  experience_summary       text check (length(experience_summary) <= 2000),
  verification_info        text check (length(verification_info) <= 1000),
  declared_roster          jsonb not null default '[]'::jsonb,
  verification_status      public.verification_status not null default 'pending',
  verification_notes       text check (length(verification_notes) <= 2000),
  verified_by              uuid references auth.users (id) on delete set null,
  verified_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index coaches_org_email_uq on public.coaches (org_id, email);

-- ---------- fighters ---------------------------------------------------------------
-- Permanent identity + PUBLIC profile fields only. Private data lives in fighter_private.
create table public.fighters (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.organizations (id) on delete restrict,
  fighter_code            text not null unique,
  fight_name              text not null check (length(trim(fight_name)) between 2 and 80),
  nickname                text check (length(nickname) <= 60),
  gym_id                  uuid references public.gyms (id) on delete set null,
  division                text not null check (division ~ '^[a-z_]{2,30}$'),
  competition_level       public.competition_level not null default 'amateur',
  primary_style           text check (length(primary_style) <= 60),
  skill_level             public.skill_level,
  height_cm               numeric(5,1) check (height_cm between 120 and 230),
  reach_cm                numeric(5,1) check (reach_cm between 110 and 250),
  hometown                text check (length(hometown) <= 80),
  country                 text check (length(country) <= 80),
  bio                     text check (length(bio) <= 1500),
  photo_path              text,            -- object in private bucket (uploaded at registration)
  public_photo_path       text,            -- object in public bucket (copied on approval)
  public_profile_approved boolean not null default false,
  status                  public.fighter_status not null default 'active',
  merged_into             uuid references public.fighters (id),
  registered_at           timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check ((status = 'merged') = (merged_into is not null)),
  check (merged_into is distinct from id)
);
create index on public.fighters (org_id, status);
create index on public.fighters (gym_id);

create table public.fighter_private (
  fighter_id             uuid primary key references public.fighters (id) on delete cascade,
  legal_name             text not null check (length(trim(legal_name)) between 2 and 120),
  date_of_birth          date not null check (date_of_birth > date '1920-01-01'),
  email                  text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone_country_code     text check (phone_country_code ~ '^\+[0-9]{1,4}$'),
  phone                  text check (phone ~ '^[0-9 ()-]{5,20}$'),
  city                   text check (length(city) <= 80),
  country                text check (length(country) <= 80),
  mma_experience_years   numeric(4,1) check (mma_experience_years between 0 and 60),
  previous_experience    text check (length(previous_experience) <= 2000),
  coach_name_declared    text check (length(coach_name_declared) <= 120),
  consent_at             timestamptz not null,
  consent_version        text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index on public.fighter_private (email);
create index on public.fighter_private (lower(legal_name), date_of_birth);

create table public.fighter_records (
  id               uuid primary key default gen_random_uuid(),
  fighter_id       uuid not null references public.fighters (id) on delete cascade,
  kind             public.record_kind not null,
  wins             smallint not null default 0 check (wins >= 0),
  losses           smallint not null default 0 check (losses >= 0),
  draws            smallint not null default 0 check (draws >= 0),
  no_contests      smallint not null default 0 check (no_contests >= 0),
  ko_tko_wins      smallint check (ko_tko_wins >= 0),
  submission_wins  smallint check (submission_wins >= 0),
  decision_wins    smallint check (decision_wins >= 0),
  total_fights     smallint generated always as (wins + losses + draws + no_contests) stored,
  verified_by      uuid references auth.users (id) on delete set null,
  verified_at      timestamptz,
  source_note      text check (length(source_note) <= 500),
  updated_at       timestamptz not null default now(),
  unique (fighter_id, kind),
  check (coalesce(ko_tko_wins, 0) + coalesce(submission_wins, 0) + coalesce(decision_wins, 0) <= wins),
  check ((kind = 'verified') = (verified_at is not null))
);

create table public.coach_fighters (
  id           uuid primary key default gen_random_uuid(),
  coach_id     uuid not null references public.coaches (id) on delete cascade,
  fighter_id   uuid not null references public.fighters (id) on delete cascade,
  status       public.link_status not null default 'pending',
  requested_by uuid references auth.users (id) on delete set null,
  decided_by   uuid references auth.users (id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (coach_id, fighter_id)
);
create index on public.coach_fighters (fighter_id);

create table public.fighter_duplicate_flags (
  id                   uuid primary key default gen_random_uuid(),
  fighter_id           uuid not null references public.fighters (id) on delete cascade,
  candidate_fighter_id uuid not null references public.fighters (id) on delete cascade,
  match_reason         text not null,
  resolution           text check (resolution in ('merged', 'not_duplicate')),
  resolved_by          uuid references auth.users (id) on delete set null,
  resolved_at          timestamptz,
  created_at           timestamptz not null default now(),
  unique (fighter_id, candidate_fighter_id),
  check (fighter_id <> candidate_fighter_id)
);

-- ---------- events -----------------------------------------------------------------
create table public.events (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.organizations (id) on delete restrict,
  event_code              text not null unique,
  slug                    text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  name                    text not null check (length(trim(name)) between 3 and 140),
  promotion               text check (length(promotion) <= 120),
  description             text check (length(description) <= 5000),
  branding                jsonb not null default '{}'::jsonb,
  registration_opens_at   timestamptz,
  registration_closes_at  timestamptz,
  starts_at               timestamptz,                -- null ⇒ "To Be Announced"
  timezone                text not null default 'UTC',
  venue_name              text check (length(venue_name) <= 140),   -- null ⇒ TBA
  venue_address           text check (length(venue_address) <= 300),
  venue_city              text check (length(venue_city) <= 80),
  venue_country           text check (length(venue_country) <= 80),
  status                  public.event_status not null default 'draft',
  is_public               boolean not null default false,
  fight_card_published    boolean not null default false,
  allow_late_registration boolean not null default false,
  eligibility             jsonb not null default '{}'::jsonb,
  rules_text              text check (length(rules_text) <= 10000),
  default_rounds          smallint not null default 3 check (default_rounds between 1 and 5),
  default_round_minutes   smallint not null default 5 check (default_round_minutes between 1 and 10),
  offer_validity_hours    integer not null default 72 check (offer_validity_hours between 1 and 720),
  notify_coaches          boolean not null default true,
  created_by              uuid references auth.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check (registration_closes_at is null or registration_opens_at is null
         or registration_closes_at > registration_opens_at),
  check (jsonb_typeof(eligibility) = 'object'),
  check (not fight_card_published or is_public)
);
create index on public.events (org_id, status);
create index on public.events (starts_at);

create table public.event_admins (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.event_role not null,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);
create index on public.event_admins (user_id);

-- event_id null ⇒ organisation template; events get their own copies.
create table public.weight_classes (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  event_id       uuid references public.events (id) on delete cascade,
  name           text not null check (length(trim(name)) between 2 and 60),
  division       text check (division ~ '^[a-z_]{2,30}$'),          -- null ⇒ any division
  min_g          integer check (min_g >= 0),                         -- exclusive lower bound
  max_g          integer not null check (max_g > 0),                 -- inclusive upper bound
  allowed_diff_g integer not null default 2268 check (allowed_diff_g >= 0), -- ≈5 lb
  sort_order     smallint not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (min_g is null or min_g < max_g)
);
create unique index weight_classes_scope_name_uq on public.weight_classes
  (org_id, coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name), coalesce(division, ''));

create table public.matchmaking_rules (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  event_id   uuid references public.events (id) on delete cascade,
  config     jsonb not null check (jsonb_typeof(config) = 'object'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index matchmaking_rules_scope_uq on public.matchmaking_rules
  (org_id, coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------- registrations ----------------------------------------------------------
create table public.event_registrations (
  id                        uuid primary key default gen_random_uuid(),
  event_id                  uuid not null references public.events (id) on delete restrict,
  fighter_id                uuid not null references public.fighters (id) on delete restrict,
  status                    public.registration_status not null default 'submitted',
  submitted_via             text not null check (submitted_via in ('self', 'coach', 'admin')),
  submitted_by_user         uuid references auth.users (id) on delete set null,
  submitted_by_coach        uuid references public.coaches (id) on delete set null,
  declared_weight_g         integer check (declared_weight_g between 30000 and 200000),
  weight_unit_entered       text check (weight_unit_entered in ('kg', 'lb')),
  weight_recorded_at        timestamptz,
  preferred_weight_class_id uuid references public.weight_classes (id) on delete set null,
  division                  text not null check (division ~ '^[a-z_]{2,30}$'),
  competition_level         public.competition_level not null,
  is_available              boolean not null default true,
  availability_notes        text check (length(availability_notes) <= 500),
  clearance_status          public.clearance_status not null default 'not_required',
  missing_info              jsonb not null default '[]'::jsonb,
  review_notes              text check (length(review_notes) <= 4000),   -- internal only
  rejection_reason          text check (length(rejection_reason) <= 1000),
  reviewed_by               uuid references auth.users (id) on delete set null,
  reviewed_at               timestamptz,
  submitted_at              timestamptz,
  late_override_by          uuid references auth.users (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (event_id, fighter_id),
  check ((declared_weight_g is null) = (weight_recorded_at is null))
);
create index on public.event_registrations (event_id, status);
create index on public.event_registrations (fighter_id);

-- Idempotency ledger for public forms (double-clicks, retries).
create table public.registration_submissions (
  submission_key uuid primary key,
  kind           text not null check (kind in ('fighter', 'coach')),
  result         jsonb not null,
  created_at     timestamptz not null default now()
);

create table public.registration_documents (
  id              uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.event_registrations (id) on delete cascade,
  kind            text not null check (kind ~ '^[a-z_]{2,40}$'),
  storage_path    text not null unique,
  mime_type       text not null,
  size_bytes      integer not null check (size_bytes between 1 and 10485760),
  review_status   public.verification_status not null default 'pending',
  uploaded_at     timestamptz not null default now()
);

create table public.coach_events (
  coach_id   uuid not null references public.coaches (id) on delete cascade,
  event_id   uuid not null references public.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (coach_id, event_id)
);

-- ---------- updated_at triggers ----------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['organizations','user_profiles','gyms','coaches','fighters','fighter_private',
                           'fighter_records','events','weight_classes','matchmaking_rules',
                           'event_registrations','system_settings']
  loop
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function private.touch_updated_at()', t);
  end loop;
end $$;
