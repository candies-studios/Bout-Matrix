-- Run once in the Supabase SQL editor (production) after deploying Edge Functions.
-- Calls the email dispatcher every minute. Requires the pg_cron and pg_net extensions
-- (Dashboard → Database → Extensions) and stores the shared secret in Vault.
--
-- 1. Replace <PROJECT_REF> and <DISPATCH_SECRET> (same value as the DISPATCH_SECRET function secret).

select vault.create_secret('<DISPATCH_SECRET>', 'dispatch_secret');

select cron.schedule(
  'email-dispatch',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/email-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000)
  $$
);

-- Verify:   select * from cron.job;   select * from cron.job_run_details order by start_time desc limit 10;
-- Remove:   select cron.unschedule('email-dispatch');
