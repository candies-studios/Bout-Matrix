-- =====================================================================================
-- 0003 · Email outbox/log, notification preferences, audit log, rate limits
-- =====================================================================================

create type public.email_status as enum ('queued', 'sending', 'sent', 'failed', 'cancelled');

create table public.email_logs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  event_id            uuid references public.events (id) on delete set null,
  template            text not null check (template ~ '^[a-z_]{3,60}$'),
  to_email            text not null check (to_email = lower(to_email)),
  to_name             text check (length(to_name) <= 120),
  payload             jsonb not null default '{}'::jsonb,  -- NEVER contains tokens or secrets
  idempotency_key     text not null unique check (length(idempotency_key) between 8 and 200),
  status              public.email_status not null default 'queued',
  attempts            smallint not null default 0,
  max_attempts        smallint not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at     timestamptz not null default now(),
  locked_until        timestamptz,
  provider_message_id text,
  last_error          text check (length(last_error) <= 2000),
  delivery_status     text check (delivery_status in ('delivered', 'delayed', 'bounced', 'complained')),
  delivery_updated_at timestamptz,
  entity_type         text check (entity_type in ('fighter', 'coach', 'registration', 'bout', 'offer', 'event')),
  entity_id           uuid,
  created_by          uuid references auth.users (id) on delete set null,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((status = 'sent') = (provider_message_id is not null and sent_at is not null)),
  check (payload::text !~* '"(token|password|secret|api_key)"')
);
create index email_logs_dispatch_idx on public.email_logs (next_attempt_at) where status = 'queued';
create index on public.email_logs (org_id, status, created_at desc);
create index on public.email_logs (entity_type, entity_id);
create trigger touch_updated_at before update on public.email_logs
  for each row execute function private.touch_updated_at();

-- Categories: 'transactional' cannot be disabled (offers, confirmations); others can.
create table public.notification_preferences (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  email      text not null check (email = lower(email)),
  category   text not null check (category in ('event_announcements', 'coach_updates', 'reminders')),
  enabled    boolean not null,
  updated_at timestamptz not null default now(),
  unique (org_id, email, category)
);

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  org_id      uuid,
  actor_id    uuid,
  actor_kind  text not null default 'user',
  action      text not null,
  table_name  text,
  record_id   text,
  changes     jsonb,
  reason      text,
  created_at  timestamptz not null default now()
);
create index on public.audit_logs (org_id, created_at desc);
create index on public.audit_logs (table_name, record_id);

create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function private.reject_mutation();
create or replace function private.reject_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception '% cannot be truncated', tg_table_name using errcode = 'insufficient_privilege'; end $$;
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function private.reject_truncate();

create table public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);

-- ---------- generic audit trigger -------------------------------------------------
-- Columns whose VALUES are never copied into the audit log (only the fact they changed).
create or replace function private.audit_redacted_columns() returns text[]
language sql immutable set search_path = '' as $$
  select array['date_of_birth','email','phone','phone_country_code','legal_name','token_hash',
               'token_nonce','ip_hash','payload','city']
$$;

create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_red text[] := private.audit_redacted_columns();
  v_org uuid;
  v_id text;
begin
  v_id := coalesce(v_new, v_old) ->> (case when coalesce(v_new, v_old) ? 'id' then 'id'
                                         when coalesce(v_new, v_old) ? 'fighter_id' then 'fighter_id'
                                         else 'org_id' end);
  v_org := nullif(coalesce(v_new, v_old) ->> 'org_id', '')::uuid;
  if v_org is null then
    -- Resolve the organisation for child tables so org admins can see their audit trail.
    if coalesce(v_new, v_old) ? 'event_id' then
      select e.org_id into v_org from public.events e where e.id = (coalesce(v_new, v_old) ->> 'event_id')::uuid;
    elsif coalesce(v_new, v_old) ? 'bout_id' then
      select b.org_id into v_org from public.bouts b where b.id = (coalesce(v_new, v_old) ->> 'bout_id')::uuid;
    elsif coalesce(v_new, v_old) ? 'fighter_id' then
      select f.org_id into v_org from public.fighters f where f.id = (coalesce(v_new, v_old) ->> 'fighter_id')::uuid;
    elsif coalesce(v_new, v_old) ? 'coach_id' then
      select c.org_id into v_org from public.coaches c where c.id = (coalesce(v_new, v_old) ->> 'coach_id')::uuid;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      continue when v_key in ('updated_at');
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(v_key,
          case when v_key = any(v_red) then jsonb_build_object('redacted', true)
               else jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key) end);
      end if;
    end loop;
    if v_changes = '{}'::jsonb then return null; end if;
  else
    for v_key in select jsonb_object_keys(coalesce(v_new, v_old)) loop
      if v_key = any(v_red) then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('redacted', true));
      else
        v_changes := v_changes || jsonb_build_object(v_key, coalesce(v_new, v_old) -> v_key);
      end if;
    end loop;
  end if;

  insert into public.audit_logs (org_id, actor_id, actor_kind, action, table_name, record_id, changes, reason)
  values (v_org,
          coalesce(nullif(current_setting('app.actor_id', true), '')::uuid, auth.uid()),
          coalesce(nullif(current_setting('app.actor_kind', true), ''),
                   case when auth.uid() is null then 'system' else 'user' end),
          lower(tg_op), tg_table_name, v_id, v_changes,
          nullif(current_setting('app.reason', true), ''));
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['organizations','user_roles','gyms','coaches','coach_fighters','fighters',
                           'fighter_private','fighter_records','events','event_admins','weight_classes',
                           'matchmaking_rules','event_registrations','bouts','bout_offers',
                           'system_settings','notification_preferences']
  loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function private.audit_row()', t);
  end loop;
end $$;
