-- =====================================================================================
-- 0007 · Storage buckets/policies and scheduled jobs.
-- Guarded so the migration also applies to plain Postgres (local DB tests), where the
-- Supabase `storage` schema and pg_cron are not present.
-- =====================================================================================

do $outer$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'storage' and c.relname = 'buckets') then

    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('registration-private', 'registration-private', false, 10485760,
            array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
           ('public-media', 'public-media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
                                   allowed_mime_types = excluded.allowed_mime_types;

    -- Private uploads are written only through signed upload URLs issued by Edge Functions.
    -- Authorised staff may read the objects attached to records they can see.
    execute $p$
      create policy "staff read registration files" on storage.objects for select to authenticated
      using (bucket_id = 'registration-private' and (
        exists (select 1 from public.fighters f where f.photo_path = storage.objects.name and private.can_view_fighter(f.id))
        or exists (select 1 from public.registration_documents d
                     join public.event_registrations er on er.id = d.registration_id
                    where d.storage_path = storage.objects.name and private.can_manage_event(er.event_id))))
    $p$;
    -- public-media is readable by anyone (bucket is public); only the service role writes to it.
  end if;
end
$outer$;

do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
    exception when others then
      raise notice 'pg_cron could not be enabled here (%). Enable it in Dashboard → Database → Extensions and re-run the cron.schedule statements from this migration.', sqlerrm;
      return;
    end;
    perform cron.schedule('expire-bout-offers', '*/5 * * * *', 'select public.svc_expire_offers()');
    perform cron.schedule('offer-expiry-reminders', '17 * * * *', 'select public.svc_queue_offer_reminders(24)');
    perform cron.schedule('purge-rate-limits', '41 3 * * *', $$delete from public.rate_limits where window_start < now() - interval '2 days'$$);
    -- The email dispatcher Edge Function is scheduled separately (it needs your project URL and a
    -- secret): run scripts/schedule-email-dispatch.sql. See docs/DEPLOYMENT.md §3.
  end if;
end
$outer$;
