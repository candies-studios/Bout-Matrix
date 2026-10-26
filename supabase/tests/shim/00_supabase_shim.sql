-- Minimal stand-in for the parts of a Supabase project that our migrations depend on.
-- Used ONLY by the local DB test harness (scripts/db-test.mjs). Never run against a real project.
--
-- Mirrors Supabase behaviour closely enough to test RLS honestly:
--   * roles anon / authenticated / service_role (service_role has BYPASSRLS, like Supabase)
--   * auth.users, auth.uid(), auth.role(), auth.jwt() reading request.jwt.claims
--   * an `extensions` schema

do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

create schema if not exists extensions;
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', current_user)
$$;

grant usage on schema auth, extensions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
-- Supabase grants schema public usage to API roles by default.
grant usage on schema public to anon, authenticated, service_role;

-- Supabase's default privileges: API roles get ALL on new tables/sequences/functions in `public`.
-- Emulated here so our migrations are tested against the same permissive starting point and must
-- revoke explicitly.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
