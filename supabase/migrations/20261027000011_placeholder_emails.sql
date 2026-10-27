-- 0011 — Never queue emails to placeholder addresses.
-- Fighters imported without an email (e.g. from the Rising Star 8 Google Form) get an address ending in
-- ".invalid" (a domain reserved for exactly this). Nothing is ever sent to such addresses.
create or replace function private.enqueue_email(
  p_org uuid, p_event uuid, p_template text, p_to text, p_to_name text, p_payload jsonb,
  p_idempotency_key text, p_entity_type text, p_entity_id uuid, p_category text default 'transactional'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_to is null or p_to = '' or lower(p_to) like '%.invalid' then return null; end if;
  if p_category <> 'transactional' and exists (
       select 1 from public.notification_preferences np
        where np.org_id = p_org and np.email = lower(p_to) and np.category = p_category and not np.enabled) then
    return null;
  end if;
  insert into public.email_logs (org_id, event_id, template, to_email, to_name, payload, idempotency_key,
                                 entity_type, entity_id, created_by)
  values (p_org, p_event, p_template, lower(p_to), p_to_name, coalesce(p_payload, '{}'::jsonb),
          p_idempotency_key, p_entity_type, p_entity_id, auth.uid())
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  return v_id;
end $$;
