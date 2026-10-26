# Deployment guide

Covers Supabase, the email provider (Resend), Vercel, the first administrator and going live.
Allow about an hour the first time. Commands assume the [Supabase CLI](https://supabase.com/docs/guides/cli)
is installed and you are in the repository root.

---

## 1. Supabase project

1. Create a project at supabase.com (choose the region closest to your fighters, e.g. Mumbai).
2. **Authentication → Providers → Email**: keep Email enabled, **turn OFF "Allow new users to sign up"**.
   Nobody can self-register; admins, matchmakers and coaches are invited.
3. **Authentication → URL configuration**: Site URL = `https://your-domain`; add redirect URLs
   `https://your-domain/admin/login` and `https://your-domain/coach`.
4. **Authentication → Emails → SMTP**: point Supabase Auth at Resend's SMTP (see §2) so invitations come
   from your domain. Optional but recommended.
5. **Database → Extensions**: enable `pg_cron` and `pg_net`.
6. Link and push the schema:

   ```bash
   supabase login
   supabase link --project-ref <PROJECT_REF>
   supabase db push            # applies supabase/migrations/* in order
   ```

   Do **not** run `supabase/seed.sql` against production — it contains synthetic people. Create your
   organisation instead (SQL editor):

   ```sql
   insert into organizations (name, slug, fighter_id_prefix, contact_email)
   values ('Your Promotion', 'your-org', 'WDS', 'ops@your-domain.example');

   -- Weight-class templates: copy the block from supabase/seed.sql ("Organisation weight-class templates"),
   -- replacing the org id, or create them later in Admin → Settings → Weight class templates.
   -- Default matchmaking rules: Admin → Settings → Default matchmaking rules → Save.
   ```

7. Storage buckets (`registration-private`, `public-media`) and the offer-expiry / reminder cron jobs are
   created by migration `0007`. Check **Storage** shows both buckets and `select * from cron.job;` lists
   `expire-bout-offers` and `offer-expiry-reminders`.

## 2. Email (Resend)

1. Create a Resend account, add your sending domain (e.g. `mail.your-domain.example`) and add the DNS
   records it shows (SPF, DKIM, and a DMARC policy). Wait for **Verified**.
2. Create an API key with "Sending access" restricted to that domain.
3. **Webhooks → Add endpoint**: `https://<PROJECT_REF>.supabase.co/functions/v1/email-webhook`, events
   `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`. Copy the signing secret
   (`whsec_…`).
4. For Supabase Auth invitations via SMTP: host `smtp.resend.com`, port 465, user `resend`, password = an API key.

How sending works: business actions write rows to `email_logs` (`queued`). The `email-dispatch` function
claims rows, renders the template, calls Resend with an `Idempotency-Key`, and marks the row **sent only when
Resend returns a message id**. Failures retry with exponential backoff (up to 5 attempts) and then show as
**failed** in Admin → Emails, where they can be retried. Delivery/bounce updates arrive via the webhook.

## 3. Edge Functions

```bash
cp .env.example supabase/.env.production      # fill in the "Edge Functions" section only
supabase secrets set --env-file supabase/.env.production
supabase functions deploy                      # deploys every function in supabase/functions
```

Generate secrets with `openssl rand -base64 48` (OFFER_TOKEN_SECRET), `openssl rand -base64 32`
(IP_HASH_SALT), `openssl rand -hex 32` (DISPATCH_SECRET). **Changing OFFER_TOKEN_SECRET invalidates every
outstanding offer link.**

Then schedule the dispatcher (every minute): edit and run `scripts/schedule-email-dispatch.sql` in the SQL
editor. Functions also nudge the dispatcher immediately after registrations and responses, so the cron is a
safety net.

Functions deployed: `register-fighter`, `register-coach`, `registration-upload-url`, `offer-view`,
`offer-respond`, `matchmaking-generate`, `bout-create`, `bout-issue-offers`, `email-dispatch`,
`email-webhook`, `invite-coach`, `invite-staff`, `fighter-profile-approval`. Gateway JWT verification is off
(`supabase/config.toml`) because each function authenticates the caller itself.

## 4. Vercel

1. Import the GitHub repository in Vercel (framework preset: Vite).
2. Environment variables (Production and Preview): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   (the **anon / publishable** key — the app refuses to start with a service-role key), `VITE_SITE_URL`,
   optionally `VITE_TURNSTILE_SITE_KEY`.
3. Deploy. `vercel.json` provides SPA routing and security headers (CSP, HSTS, no-index for offer and admin
   pages). If you serve images from another host, extend the CSP `img-src`.
4. Add your custom domain and update `SITE_URL` / `ALLOWED_ORIGINS` secrets and Supabase Auth URLs to match.

## 5. First administrator

1. Supabase → Authentication → Users → **Add user** → your email, a strong password, tick *Auto confirm*.
2. Run `scripts/bootstrap-admin.sql` (instructions inside) — it makes you super admin + org admin for your
   organisation. This is the only time you need SQL; invite everyone else from Admin → Settings → Users or
   Admin → Events → Staff.
3. Sign in at `/admin/login` and change your password under **Account** if needed.

## 6. Go-live checklist

- [ ] Sign-ups disabled in Supabase Auth.
- [ ] `select count(*) from fighters;` returns 0 (no seed data in production).
- [ ] Test registration with your own email → confirmation email arrives, fighter ID shown.
- [ ] Admin → Emails shows the message as **sent**, then **delivered** (webhook working).
- [ ] Create a test event, approve two test fighters, create a bout, send offers to two inboxes you control,
      accept both, confirm, publish, check the public fight card. Then cancel and delete the test data via
      status changes (bouts) — fighters are never hard-deleted (see `docs/BACKUP.md` for erasure requests).
- [ ] Optional: Turnstile keys configured; check the widget appears on registration forms.
- [ ] Backups: Supabase plan with daily backups / PITR enabled (see `docs/BACKUP.md`).

## 7. Updating

```bash
git pull
supabase db push            # new migrations only; never edit an applied migration
supabase functions deploy
# Vercel redeploys on push to main
```
