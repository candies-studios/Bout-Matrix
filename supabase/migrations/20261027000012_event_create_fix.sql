-- 0012 — Admins could not create events from the app ("You do not have permission to do that.").
-- Creating an event asks for the new row back (INSERT … RETURNING). The read rule checked access by looking
-- the event up in public.events, where the brand-new row is not yet visible, so the insert was rejected.
-- Organisation admins are now recognised from the row's own org_id (they can see every event in their org anyway).
drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated
  using (private.is_org_admin(org_id) or private.can_matchmake_event(id));
