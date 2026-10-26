-- =====================================================================================
-- 0008 · Settings & staff management
-- =====================================================================================

-- The fighter-ID prefix is configurable; already-issued IDs never change (fighter_code is immutable).
grant update (fighter_id_prefix) on public.organizations to authenticated;

create or replace function public.svc_can_admin_org(p_actor uuid, p_org uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_org_admin(p_org, p_actor) then perform private.raise_app('forbidden', 'Only organisation administrators can do that.'); end if;
end $$;

create or replace function public.svc_grant_staff(p_actor uuid, p_org uuid, p_user uuid, p_email text, p_full_name text,
                                                 p_role public.app_role, p_event uuid, p_event_role public.event_role)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_org_admin(p_org, p_actor) then perform private.raise_app('forbidden', 'Only organisation administrators can do that.'); end if;
  if p_role not in ('org_admin', 'staff') then perform private.raise_app('invalid', 'Invalid role.'); end if;
  perform private.set_context(p_actor, 'user', 'staff invited');
  insert into public.user_profiles (id, org_id, email, full_name) values (p_user, p_org, lower(p_email), p_full_name)
  on conflict (id) do update set org_id = coalesce(public.user_profiles.org_id, excluded.org_id),
                                 full_name = coalesce(public.user_profiles.full_name, excluded.full_name);
  insert into public.user_roles (user_id, org_id, role, granted_by) values (p_user, p_org, p_role, p_actor) on conflict do nothing;
  if p_event is not null then
    if not exists (select 1 from public.events where id = p_event and org_id = p_org) then
      perform private.raise_app('invalid', 'Event not found.');
    end if;
    insert into public.event_admins (event_id, user_id, role, granted_by)
    values (p_event, p_user, coalesce(p_event_role, 'matchmaker'), p_actor)
    on conflict (event_id, user_id) do update set role = excluded.role;
  end if;
end $$;

revoke all on function public.svc_can_admin_org(uuid, uuid), public.svc_grant_staff(uuid, uuid, uuid, text, text, public.app_role, uuid, public.event_role)
  from public, anon, authenticated;
grant execute on function public.svc_can_admin_org(uuid, uuid), public.svc_grant_staff(uuid, uuid, uuid, text, text, public.app_role, uuid, public.event_role)
  to service_role;
