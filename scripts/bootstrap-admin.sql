-- First administrator bootstrap. Run ONCE in the Supabase SQL editor (or psql) AFTER creating the
-- user in Dashboard → Authentication → Users → "Add user" (with "Auto confirm" ticked).
--
--   psql "$DATABASE_URL" -v email="'you@example.com'" -v full_name="'Your Name'" \
--        -v org_slug="'demo'" -f scripts/bootstrap-admin.sql
--
-- In the SQL editor, replace :email / :full_name / :org_slug with quoted literals.

begin;

insert into public.user_profiles (id, org_id, email, full_name)
select u.id, o.id, lower(u.email), :full_name
  from auth.users u, public.organizations o
 where lower(u.email) = lower(:email) and o.slug = :org_slug
on conflict (id) do update set org_id = excluded.org_id, full_name = excluded.full_name;

insert into public.user_roles (user_id, org_id, role)
select u.id, o.id, r.role::public.app_role
  from auth.users u, public.organizations o, (values ('super_admin'), ('org_admin')) as r(role)
 where lower(u.email) = lower(:email) and o.slug = :org_slug
on conflict (user_id, org_id, role) do nothing;

-- Fails loudly if the user or organisation does not exist.
do $$ begin
  if not exists (select 1 from public.user_roles ur join public.user_profiles up on up.id = ur.user_id
                  where ur.role = 'super_admin') then
    raise exception 'bootstrap failed: user or organisation not found';
  end if;
end $$;

commit;
