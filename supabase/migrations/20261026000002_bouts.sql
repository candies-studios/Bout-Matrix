-- =====================================================================================
-- 0002 · Matchmaking suggestions, bouts, offers, responses, state machine
-- =====================================================================================

create type public.bout_status as enum (
  'draft', 'offer_sent', 'awaiting_responses', 'accepted_one', 'accepted_both',
  'declined', 'expired', 'under_review', 'confirmed', 'cancelled', 'completed');
create type public.offer_status as enum (
  'pending', 'accepted', 'declined', 'expired', 'revoked', 'superseded', 'withdrawn');
create type public.offer_response as enum ('accept', 'decline');
create type public.match_classification as enum (
  'strong_candidate', 'possible_candidate', 'requires_review', 'ineligible');

-- ---------- matchmaking suggestions ------------------------------------------------
create table public.matchmaking_suggestions (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events (id) on delete cascade,
  fighter_a_id   uuid not null references public.fighters (id) on delete cascade,
  fighter_b_id   uuid not null references public.fighters (id) on delete cascade,
  score          numeric(5,2) check (score between 0 and 100),
  classification public.match_classification not null,
  evaluation     jsonb not null,          -- reasons, warnings, missing info, component scores
  rules_snapshot jsonb not null,
  status         text not null default 'open' check (status in ('open', 'dismissed', 'converted', 'stale')),
  bout_id        uuid,
  generated_by   uuid references auth.users (id) on delete set null,
  generated_at   timestamptz not null default now(),
  check (fighter_a_id < fighter_b_id)     -- canonical ordering ⇒ one row per pair
);
create unique index matchmaking_suggestions_open_pair_uq
  on public.matchmaking_suggestions (event_id, fighter_a_id, fighter_b_id) where status = 'open';

-- ---------- bouts ------------------------------------------------------------------
create table public.bouts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete restrict,
  event_id            uuid not null references public.events (id) on delete restrict,
  bout_code           text not null unique,
  fighter_a_id        uuid not null references public.fighters (id) on delete restrict,
  fighter_b_id        uuid not null references public.fighters (id) on delete restrict,
  weight_class_id     uuid references public.weight_classes (id) on delete restrict,
  contracted_weight_g integer check (contracted_weight_g between 30000 and 200000),
  rounds              smallint not null default 3 check (rounds between 1 and 5),
  round_minutes       smallint not null default 5 check (round_minutes between 1 and 10),
  rules_text          text check (length(rules_text) <= 4000),
  proposed_starts_at  timestamptz,       -- null ⇒ use event date
  offer_expires_at    timestamptz,
  status              public.bout_status not null default 'draft',
  offer_version       integer not null default 0 check (offer_version >= 0),
  card_order          smallint check (card_order between 1 and 99),
  card_segment        text check (card_segment in ('main_card', 'prelims', 'early_prelims')),
  is_published        boolean not null default false,
  published_at        timestamptz,
  confirmed_by        uuid references auth.users (id) on delete set null,
  confirmed_at        timestamptz,
  evaluation          jsonb,             -- matchmaking evaluation at creation (server computed)
  override_reason     text check (length(override_reason) <= 2000),
  suggestion_id       uuid references public.matchmaking_suggestions (id) on delete set null,
  replaces_bout_id    uuid references public.bouts (id) on delete set null,
  admin_notes         text check (length(admin_notes) <= 4000),
  cancel_reason       text check (length(cancel_reason) <= 1000),
  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (fighter_a_id <> fighter_b_id),
  check (not is_published or status in ('confirmed', 'completed')),
  check ((status <> 'confirmed') or confirmed_at is not null)
);
create index on public.bouts (event_id, status);
create index on public.bouts (fighter_a_id);
create index on public.bouts (fighter_b_id);
create unique index bouts_event_card_order_uq on public.bouts (event_id, card_order)
  where card_order is not null and status not in ('cancelled');

alter table public.matchmaking_suggestions
  add constraint matchmaking_suggestions_bout_fk foreign key (bout_id) references public.bouts (id) on delete set null;

-- Trigger-maintained. The partial unique index is the hard guarantee that a fighter cannot hold
-- two active bouts in the same event, even under concurrent writes.
create table public.bout_participants (
  bout_id    uuid not null references public.bouts (id) on delete cascade,
  event_id   uuid not null references public.events (id) on delete cascade,
  fighter_id uuid not null references public.fighters (id) on delete restrict,
  corner     char(1) not null check (corner in ('A', 'B')),
  is_active  boolean not null,
  primary key (bout_id, corner)
);
create unique index bout_participants_active_uq on public.bout_participants (event_id, fighter_id) where is_active;
create index on public.bout_participants (fighter_id);

create table public.bout_status_transitions (
  from_status public.bout_status not null,
  to_status   public.bout_status not null,
  primary key (from_status, to_status)
);
insert into public.bout_status_transitions (from_status, to_status) values
  ('draft', 'offer_sent'), ('draft', 'cancelled'),
  ('offer_sent', 'awaiting_responses'), ('offer_sent', 'accepted_one'), ('offer_sent', 'declined'),
  ('offer_sent', 'expired'), ('offer_sent', 'under_review'), ('offer_sent', 'cancelled'),
  ('awaiting_responses', 'accepted_one'), ('awaiting_responses', 'declined'),
  ('awaiting_responses', 'expired'), ('awaiting_responses', 'under_review'), ('awaiting_responses', 'cancelled'),
  ('accepted_one', 'accepted_both'), ('accepted_one', 'declined'), ('accepted_one', 'expired'),
  ('accepted_one', 'under_review'), ('accepted_one', 'cancelled'),
  ('accepted_both', 'confirmed'), ('accepted_both', 'under_review'), ('accepted_both', 'cancelled'),
  ('declined', 'under_review'), ('declined', 'cancelled'),
  ('expired', 'under_review'), ('expired', 'offer_sent'), ('expired', 'cancelled'),
  ('under_review', 'draft'), ('under_review', 'offer_sent'), ('under_review', 'confirmed'),
  ('under_review', 'cancelled'),
  ('confirmed', 'completed'), ('confirmed', 'under_review'), ('confirmed', 'cancelled');

create table public.bout_status_history (
  id          bigint generated always as identity primary key,
  bout_id     uuid not null references public.bouts (id) on delete cascade,
  from_status public.bout_status,
  to_status   public.bout_status not null,
  actor_id    uuid references auth.users (id) on delete set null,
  actor_kind  text not null check (actor_kind in ('user', 'fighter', 'system')),
  reason      text check (length(reason) <= 2000),
  created_at  timestamptz not null default now()
);
create index on public.bout_status_history (bout_id, created_at);

-- ---------- offers & responses -----------------------------------------------------
create table public.bout_offers (
  id               uuid primary key,          -- generated by the Edge Function (needed to derive the token)
  bout_id          uuid not null references public.bouts (id) on delete cascade,
  fighter_id       uuid not null references public.fighters (id) on delete restrict,
  corner           char(1) not null check (corner in ('A', 'B')),
  offer_version    integer not null check (offer_version >= 1),
  token_nonce      text not null check (length(token_nonce) >= 22),
  token_hash       text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),  -- sha256(token), hex
  status           public.offer_status not null default 'pending',
  expires_at       timestamptz not null,
  terms_snapshot   jsonb not null,
  sent_at          timestamptz,
  first_viewed_at  timestamptz,
  responded_at     timestamptz,
  revoked_at       timestamptz,
  revoked_reason   text check (length(revoked_reason) <= 500),
  reminder_sent_at timestamptz,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (bout_id, corner, offer_version)
);
create index on public.bout_offers (status, expires_at);
create index on public.bout_offers (fighter_id);

create table public.bout_responses (
  id             uuid primary key default gen_random_uuid(),
  offer_id       uuid not null unique references public.bout_offers (id) on delete restrict, -- one answer per offer
  bout_id        uuid not null references public.bouts (id) on delete restrict,
  fighter_id     uuid not null references public.fighters (id) on delete restrict,
  response       public.offer_response not null,
  decline_reason text check (length(decline_reason) <= 1000),
  ip_hash        text check (ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent     text check (length(user_agent) <= 400),
  responded_at   timestamptz not null default now()
);

create trigger touch_updated_at before update on public.bouts
  for each row execute function private.touch_updated_at();

-- ---------- state machine & invariants --------------------------------------------
create or replace function private.bout_is_active(s public.bout_status) returns boolean
language sql immutable set search_path = '' as $$
  select s not in ('declined', 'expired', 'cancelled', 'completed')
$$;
-- NOTE: 'declined' and 'expired' bouts release their fighters so a replacement can be booked.
-- They can only return to an active state via under_review, which re-checks the unique index.

create or replace function private.bouts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_reason  text := nullif(current_setting('app.reason', true), '');
  v_kind    text := coalesce(nullif(current_setting('app.actor_kind', true), ''), 'user');
  v_actor   uuid := coalesce(nullif(current_setting('app.actor_id', true), '')::uuid, auth.uid());
  v_accepts integer;
  terms_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'bouts must be created in draft status' using errcode = 'check_violation';
    end if;
    if new.is_published then
      raise exception 'new bouts cannot be published' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Immutable columns
  if new.event_id <> old.event_id or new.org_id <> old.org_id or new.bout_code <> old.bout_code then
    raise exception 'event, organisation and bout code cannot change' using errcode = 'check_violation';
  end if;

  terms_changed := (new.fighter_a_id, new.fighter_b_id, new.weight_class_id, new.contracted_weight_g,
                    new.rounds, new.round_minutes, new.rules_text)
                   is distinct from
                   (old.fighter_a_id, old.fighter_b_id, old.weight_class_id, old.contracted_weight_g,
                    old.rounds, old.round_minutes, old.rules_text);

  if terms_changed then
    if old.status not in ('draft', 'under_review') or new.status <> old.status then
      raise exception 'bout terms can only be changed while the bout is in draft or under_review (current: %)', old.status
        using errcode = 'check_violation', hint = 'Move the bout to under_review first; fighters will need to re-accept.';
    end if;
    if old.status = 'under_review' and new.offer_version = old.offer_version then
      -- Changing terms invalidates every acceptance of the current version.
      new.offer_version := old.offer_version + 1;
    end if;
  end if;

  if new.offer_version < old.offer_version then
    raise exception 'offer_version cannot decrease' using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    if not exists (select 1 from public.bout_status_transitions t
                   where t.from_status = old.status and t.to_status = new.status) then
      raise exception 'invalid bout status transition % → %', old.status, new.status
        using errcode = 'check_violation';
    end if;

    if new.status = 'confirmed' then
      select count(*) into v_accepts from public.bout_offers o
       where o.bout_id = new.id and o.offer_version = new.offer_version and o.status = 'accepted';
      if new.offer_version = 0 or v_accepts < 2 then
        raise exception 'a bout can only be confirmed after both fighters accept the current offer'
          using errcode = 'check_violation';
      end if;
      if v_kind <> 'user' or v_actor is null then
        raise exception 'confirmation requires an authenticated administrator' using errcode = 'check_violation';
      end if;
      new.confirmed_at := now();
      new.confirmed_by := v_actor;
    end if;

    if new.status in ('under_review', 'cancelled') and v_reason is null then
      raise exception 'a reason is required to move a bout to %', new.status using errcode = 'check_violation';
    end if;

    -- Leaving a publishable state always unpublishes.
    if new.status not in ('confirmed', 'completed') then
      new.is_published := false;
      new.published_at := null;
    end if;
    if new.status = 'cancelled' then
      new.cancel_reason := coalesce(new.cancel_reason, v_reason);
    end if;

    insert into public.bout_status_history (bout_id, from_status, to_status, actor_id, actor_kind, reason)
    values (new.id, old.status, new.status, v_actor, v_kind, v_reason);
  end if;

  if new.is_published and not old.is_published then
    new.published_at := now();
  elsif not new.is_published then
    new.published_at := null;
  end if;

  return new;
end $$;

create trigger bouts_guard before insert or update on public.bouts
  for each row execute function private.bouts_guard();

create or replace function private.bouts_after_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_active boolean := private.bout_is_active(new.status);
begin
  if tg_op = 'INSERT' then
    insert into public.bout_status_history (bout_id, from_status, to_status, actor_id, actor_kind, reason)
    values (new.id, null, new.status,
            coalesce(nullif(current_setting('app.actor_id', true), '')::uuid, auth.uid()),
            coalesce(nullif(current_setting('app.actor_kind', true), ''), 'user'),
            nullif(current_setting('app.reason', true), ''));
  end if;

  -- Sync participants (delete + insert keeps it simple and lets the unique index do the work).
  delete from public.bout_participants where bout_id = new.id;
  insert into public.bout_participants (bout_id, event_id, fighter_id, corner, is_active) values
    (new.id, new.event_id, new.fighter_a_id, 'A', v_active),
    (new.id, new.event_id, new.fighter_b_id, 'B', v_active);
  return null;
exception when unique_violation then
  raise exception 'fighter already has an active bout in this event'
    using errcode = 'unique_violation', hint = 'Cancel or resolve the existing bout first.';
end $$;

create trigger bouts_after_write after insert or update on public.bouts
  for each row execute function private.bouts_after_write();

-- Responses are an append-only ledger.
create or replace function private.reject_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;

create trigger bout_responses_append_only before update or delete on public.bout_responses
  for each row execute function private.reject_mutation();
create trigger bout_status_history_append_only before update or delete on public.bout_status_history
  for each row execute function private.reject_mutation();
