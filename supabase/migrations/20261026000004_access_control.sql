-- =====================================================================================
-- 0004 · Authorization helpers, privileges and Row Level Security
-- =====================================================================================
-- Model
--   * anon: no table privileges at all. Public data only via SECURITY DEFINER RPCs (0006).
--   * authenticated: table privileges are granted narrowly (often per column); RLS selects rows.
--   * service_role: Edge Functions only (BYPASSRLS). Those functions verify the caller themselves.
-- Helpers live in schema `private`, which PostgREST does not expose.
-- =====================================================================================

grant usage on schema private to authenticated, service_role;

-- ---------- helpers ----------------------------------------------------------------
create or replace function private.is_super_admin(p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_uid is not null and exists (
    select 1 from public.user_roles r where r.user_id = p_uid and r.role = 'super_admin')
$$;

create or replace function private.has_org_role(p_org uuid, p_roles public.app_role[], p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select p_uid is not null and (
    private.is_super_admin(p_uid) or exists (
      select 1 from public.user_roles r
       where r.user_id = p_uid and r.org_id = p_org and r.role = any(p_roles)))
$$;

create or replace function private.is_org_admin(p_org uuid, p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_org_role(p_org, array['org_admin']::public.app_role[], p_uid)
$$;

create or replace function private.is_org_staff(p_org uuid, p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_org_role(p_org, array['org_admin','staff']::public.app_role[], p_uid)
$$;

create or replace function private.can_manage_event(p_event uuid, p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_uid is not null and exists (
    select 1 from public.events e
     where e.id = p_event
       and (private.is_org_admin(e.org_id, p_uid)
            or (private.is_org_staff(e.org_id, p_uid) and exists (
                  select 1 from public.event_admins ea
                   where ea.event_id = e.id and ea.user_id = p_uid and ea.role = 'event_admin'))))
$$;

create or replace function private.can_matchmake_event(p_event uuid, p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_uid is not null and exists (
    select 1 from public.events e
     where e.id = p_event
       and (private.is_org_admin(e.org_id, p_uid)
            or (private.is_org_staff(e.org_id, p_uid) and exists (
                  select 1 from public.event_admins ea
                   where ea.event_id = e.id and ea.user_id = p_uid))))
$$;

create or replace function private.current_coach_id(p_uid uuid default auth.uid()) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.coaches c
   where p_uid is not null and c.user_id = p_uid and c.verification_status = 'verified'
     and private.has_org_role(c.org_id, array['coach']::public.app_role[], p_uid)
$$;

create or replace function private.coach_can_access_fighter(p_fighter uuid, p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.coach_fighters cf
     where cf.fighter_id = p_fighter and cf.status = 'approved'
       and cf.coach_id = private.current_coach_id(p_uid))
$$;

create or replace function private.can_view_fighter(p_fighter uuid, p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_uid is not null and (
    exists (select 1 from public.fighters f where f.id = p_fighter and private.is_org_admin(f.org_id, p_uid))
    or exists (select 1 from public.event_registrations er
                where er.fighter_id = p_fighter and private.can_matchmake_event(er.event_id, p_uid))
    or private.coach_can_access_fighter(p_fighter, p_uid))
$$;

create or replace function private.can_edit_fighter(p_fighter uuid, p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_uid is not null and (
    exists (select 1 from public.fighters f where f.id = p_fighter and private.is_org_admin(f.org_id, p_uid))
    or exists (select 1 from public.event_registrations er
                where er.fighter_id = p_fighter and private.can_manage_event(er.event_id, p_uid)))
$$;

create or replace function private.can_view_bout(p_bout uuid, p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bouts b where b.id = p_bout and private.can_matchmake_event(b.event_id, p_uid))
$$;

revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, service_role;

-- ---------- privileges: start from nothing -----------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.organizations, public.user_profiles, public.user_roles, public.system_settings,
                public.gyms, public.coaches, public.coach_fighters, public.fighters, public.fighter_private,
                public.fighter_records, public.fighter_duplicate_flags, public.events, public.event_admins,
                public.weight_classes, public.matchmaking_rules, public.event_registrations,
                public.registration_documents, public.coach_events, public.matchmaking_suggestions,
                public.bouts, public.bout_participants, public.bout_status_transitions,
                public.bout_status_history, public.email_logs, public.notification_preferences,
                public.audit_logs
  to authenticated;

-- Offer tokens and response fingerprints are never readable through the API.
grant select (id, bout_id, fighter_id, corner, offer_version, status, expires_at, terms_snapshot, sent_at,
              first_viewed_at, responded_at, revoked_at, revoked_reason, reminder_sent_at, created_at)
  on public.bout_offers to authenticated;
grant select (id, offer_id, bout_id, fighter_id, response, decline_reason, responded_at)
  on public.bout_responses to authenticated;

grant update (name, branding, contact_email) on public.organizations to authenticated;
grant update (full_name) on public.user_profiles to authenticated;
grant insert, delete on public.user_roles to authenticated;
grant insert, update on public.system_settings to authenticated;
grant insert, update on public.gyms to authenticated;
grant update (gym_id, full_name, phone_country_code, phone, city, country, coaching_experience_years,
              experience_summary, verification_status, verification_notes) on public.coaches to authenticated;
grant insert on public.coach_fighters to authenticated;
grant update (status) on public.coach_fighters to authenticated;
grant update (fight_name, nickname, gym_id, division, competition_level, primary_style, skill_level, height_cm,
              reach_cm, hometown, country, bio, public_profile_approved, status)
  on public.fighters to authenticated;
grant update (legal_name, date_of_birth, email, phone_country_code, phone, city, country,
              mma_experience_years, previous_experience) on public.fighter_private to authenticated;
grant insert, update on public.fighter_records to authenticated;
grant update (resolution) on public.fighter_duplicate_flags to authenticated;
grant insert on public.events to authenticated;
grant update (name, promotion, description, branding, registration_opens_at, registration_closes_at, starts_at,
              timezone, venue_name, venue_address, venue_city, venue_country, status, is_public,
              allow_late_registration, eligibility, rules_text, default_rounds, default_round_minutes,
              offer_validity_hours, notify_coaches) on public.events to authenticated;
grant insert, delete on public.event_admins to authenticated;
grant insert, update, delete on public.weight_classes to authenticated;
grant insert, update on public.matchmaking_rules to authenticated;
grant update (declared_weight_g, weight_unit_entered, weight_recorded_at, preferred_weight_class_id, division,
              competition_level, is_available, availability_notes, clearance_status, review_notes)
  on public.event_registrations to authenticated;
grant update (review_status) on public.registration_documents to authenticated;
grant update (status) on public.matchmaking_suggestions to authenticated;
grant update (weight_class_id, contracted_weight_g, rounds, round_minutes, rules_text, proposed_starts_at,
              offer_expires_at, card_order, card_segment, admin_notes)
  on public.bouts to authenticated;
grant insert, update on public.notification_preferences to authenticated;

-- ---------- RLS --------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- organizations
create policy org_select on public.organizations for select to authenticated
  using ((select private.is_super_admin()) or exists (
    select 1 from public.user_roles r where r.org_id = organizations.id and r.user_id = (select auth.uid())));
create policy org_update on public.organizations for update to authenticated
  using (private.is_org_admin(id)) with check (private.is_org_admin(id));

-- user_profiles
create policy profiles_select on public.user_profiles for select to authenticated
  using (id = (select auth.uid()) or (org_id is not null and private.is_org_admin(org_id)));
create policy profiles_update on public.user_profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- user_roles: org admins manage roles inside their org; only super admins grant super_admin.
create policy roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or private.is_org_admin(org_id));
create policy roles_insert on public.user_roles for insert to authenticated
  with check (private.is_org_admin(org_id)
              and (role <> 'super_admin' or (select private.is_super_admin()))
              and granted_by = (select auth.uid()));
create policy roles_delete on public.user_roles for delete to authenticated
  using (private.is_org_admin(org_id) and (role <> 'super_admin' or (select private.is_super_admin()))
         and user_id <> (select auth.uid()));

-- system_settings
create policy settings_select on public.system_settings for select to authenticated using (private.is_org_staff(org_id));
create policy settings_insert on public.system_settings for insert to authenticated with check (private.is_org_admin(org_id));
create policy settings_update on public.system_settings for update to authenticated
  using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));

-- gyms
create policy gyms_select on public.gyms for select to authenticated
  using (private.is_org_staff(org_id)
         or id = (select c.gym_id from public.coaches c where c.id = (select private.current_coach_id())));
create policy gyms_insert on public.gyms for insert to authenticated with check (private.is_org_admin(org_id));
create policy gyms_update on public.gyms for update to authenticated
  using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));

-- coaches (contact data: org admins, event staff of events the coach is linked to, and self)
create policy coaches_select on public.coaches for select to authenticated
  using (private.is_org_admin(org_id) or user_id = (select auth.uid())
         or exists (select 1 from public.coach_events ce
                     where ce.coach_id = coaches.id and private.can_matchmake_event(ce.event_id)));
create policy coaches_update on public.coaches for update to authenticated
  using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));

-- coach_fighters: a verified coach may *request* a link; only org admins decide.
create policy coach_fighters_select on public.coach_fighters for select to authenticated
  using (coach_id = (select private.current_coach_id())
         or exists (select 1 from public.fighters f where f.id = fighter_id and private.is_org_admin(f.org_id)));
create policy coach_fighters_insert on public.coach_fighters for insert to authenticated
  with check (coach_id = (select private.current_coach_id()) and status = 'pending'
              and requested_by = (select auth.uid()));
create policy coach_fighters_update on public.coach_fighters for update to authenticated
  using (exists (select 1 from public.fighters f where f.id = fighter_id and private.is_org_admin(f.org_id)))
  with check (exists (select 1 from public.fighters f where f.id = fighter_id and private.is_org_admin(f.org_id)));

-- fighters / private / records
create policy fighters_select on public.fighters for select to authenticated using (private.can_view_fighter(id));
create policy fighters_update on public.fighters for update to authenticated
  using (private.can_edit_fighter(id)) with check (private.can_edit_fighter(id));
create policy fighter_private_select on public.fighter_private for select to authenticated
  using (private.can_view_fighter(fighter_id));
create policy fighter_private_update on public.fighter_private for update to authenticated
  using (private.can_edit_fighter(fighter_id)) with check (private.can_edit_fighter(fighter_id));
create policy fighter_records_select on public.fighter_records for select to authenticated
  using (private.can_view_fighter(fighter_id));
create policy fighter_records_insert on public.fighter_records for insert to authenticated
  with check (private.can_edit_fighter(fighter_id)
              and (kind = 'self_reported' or verified_by = (select auth.uid())));
create policy fighter_records_update on public.fighter_records for update to authenticated
  using (private.can_edit_fighter(fighter_id))
  with check (private.can_edit_fighter(fighter_id)
              and (kind = 'self_reported' or verified_by = (select auth.uid())));
create policy dup_flags_select on public.fighter_duplicate_flags for select to authenticated
  using (exists (select 1 from public.fighters f where f.id = fighter_id and private.is_org_admin(f.org_id)));
create policy dup_flags_update on public.fighter_duplicate_flags for update to authenticated
  using (exists (select 1 from public.fighters f where f.id = fighter_id and private.is_org_admin(f.org_id)));

-- events
create policy events_select on public.events for select to authenticated
  using (private.can_matchmake_event(id));
create policy events_insert on public.events for insert to authenticated
  with check (private.is_org_admin(org_id) and created_by = (select auth.uid()));
create policy events_update on public.events for update to authenticated
  using (private.can_manage_event(id)) with check (private.can_manage_event(id));

create policy event_admins_select on public.event_admins for select to authenticated
  using (user_id = (select auth.uid()) or private.can_manage_event(event_id));
create policy event_admins_insert on public.event_admins for insert to authenticated
  with check (exists (select 1 from public.events e where e.id = event_id and private.is_org_admin(e.org_id))
              and granted_by = (select auth.uid()));
create policy event_admins_delete on public.event_admins for delete to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and private.is_org_admin(e.org_id)));

-- weight classes & rules: org templates (event_id null) by org admins; event copies by event managers
create policy weight_classes_select on public.weight_classes for select to authenticated
  using (case when event_id is null then private.is_org_staff(org_id) else private.can_matchmake_event(event_id) end);
create policy weight_classes_write on public.weight_classes for all to authenticated
  using (case when event_id is null then private.is_org_admin(org_id) else private.can_manage_event(event_id) end)
  with check (case when event_id is null then private.is_org_admin(org_id)
                   else private.can_manage_event(event_id)
                        and org_id = (select e.org_id from public.events e where e.id = event_id) end);
create policy mm_rules_select on public.matchmaking_rules for select to authenticated
  using (case when event_id is null then private.is_org_staff(org_id) else private.can_matchmake_event(event_id) end);
create policy mm_rules_insert on public.matchmaking_rules for insert to authenticated
  with check (case when event_id is null then private.is_org_admin(org_id)
                   else private.can_manage_event(event_id)
                        and org_id = (select e.org_id from public.events e where e.id = event_id) end);
create policy mm_rules_update on public.matchmaking_rules for update to authenticated
  using (case when event_id is null then private.is_org_admin(org_id) else private.can_manage_event(event_id) end)
  with check (case when event_id is null then private.is_org_admin(org_id) else private.can_manage_event(event_id) end);

-- registrations
create policy registrations_select on public.event_registrations for select to authenticated
  using (private.can_matchmake_event(event_id) or private.coach_can_access_fighter(fighter_id));
create policy registrations_update on public.event_registrations for update to authenticated
  using (private.can_manage_event(event_id)) with check (private.can_manage_event(event_id));
create policy reg_docs_select on public.registration_documents for select to authenticated
  using (exists (select 1 from public.event_registrations er
                  where er.id = registration_id and private.can_manage_event(er.event_id)));
create policy reg_docs_update on public.registration_documents for update to authenticated
  using (exists (select 1 from public.event_registrations er
                  where er.id = registration_id and private.can_manage_event(er.event_id)));
create policy coach_events_select on public.coach_events for select to authenticated
  using (coach_id = (select private.current_coach_id()) or private.can_matchmake_event(event_id));

-- matchmaking & bouts (scoped to events the user can matchmake)
create policy suggestions_select on public.matchmaking_suggestions for select to authenticated
  using (private.can_matchmake_event(event_id));
create policy suggestions_update on public.matchmaking_suggestions for update to authenticated
  using (private.can_matchmake_event(event_id)) with check (private.can_matchmake_event(event_id));
create policy bouts_select on public.bouts for select to authenticated using (private.can_matchmake_event(event_id));
create policy bouts_update on public.bouts for update to authenticated
  using (private.can_matchmake_event(event_id)) with check (private.can_matchmake_event(event_id));
create policy bout_participants_select on public.bout_participants for select to authenticated
  using (private.can_matchmake_event(event_id));
create policy bout_transitions_select on public.bout_status_transitions for select to authenticated using (true);
create policy bout_history_select on public.bout_status_history for select to authenticated
  using (private.can_view_bout(bout_id));
create policy bout_offers_select on public.bout_offers for select to authenticated using (private.can_view_bout(bout_id));
create policy bout_responses_select on public.bout_responses for select to authenticated using (private.can_view_bout(bout_id));

-- ops
create policy email_logs_select on public.email_logs for select to authenticated
  using (private.is_org_admin(org_id) or (event_id is not null and private.can_manage_event(event_id)));
create policy notif_prefs_select on public.notification_preferences for select to authenticated
  using (private.is_org_admin(org_id));
create policy notif_prefs_insert on public.notification_preferences for insert to authenticated
  with check (private.is_org_admin(org_id));
create policy notif_prefs_update on public.notification_preferences for update to authenticated
  using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));
create policy audit_select on public.audit_logs for select to authenticated
  using (case when org_id is null then (select private.is_super_admin()) else private.is_org_admin(org_id) end);
-- id_counters, registration_submissions, rate_limits: no policies ⇒ unreachable for API roles.
