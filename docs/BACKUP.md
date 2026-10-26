# Backup, recovery and data retention

## Backups
- **Supabase managed backups**: Pro plan and above take daily backups (7–30 days by plan). Enable
  **Point-in-Time Recovery** for the production project so you can restore to any second (recommended
  before each event).
- **Independent logical backup** (weekly, kept off-platform, encrypted):

  ```bash
  supabase db dump --linked -f backup-$(date +%F).sql            # schema
  supabase db dump --linked --data-only -f data-$(date +%F).sql  # data
  gpg --symmetric --cipher-algo AES256 data-$(date +%F).sql      # encrypt before storing
  ```
  Store in a separate cloud account with restricted access. The dump contains personal data — treat it as such.
- **Storage**: buckets are not included in database dumps. Export `registration-private` and `public-media`
  with the Supabase CLI or S3-compatible tooling on the same schedule.
- **Code & configuration**: the Git repository is the source of truth for schema (migrations), functions,
  templates and policies.

## Restore drills
Twice a year restore the latest dump into a scratch Supabase project, run `npm run test:db`-style checks
(or open the admin dashboard) and confirm counts match. Record the date in your ops log.

## Recovery scenarios
| Scenario | Action |
|---|---|
| Bad admin change | Find it in Admin → Audit log (who/what/when/why); fix forward. |
| Accidental bout cancellation | Cancelled is terminal by design; create a replacement bout (history keeps both). |
| Offer secret leaked | Rotate `OFFER_TOKEN_SECRET`, then re-issue offers (old links stop working). |
| Service-role key leaked | Rotate in Supabase → Settings → API, update function secrets, review audit log. |
| Database corruption / deletion | Restore via PITR to a new project, repoint Vercel env vars. |

## Retention and erasure
- Fighters are never hard-deleted by the application, so IDs are never reused and fight history stays intact.
- **Erasure requests**: an org admin pseudonymises the person in the SQL editor:
  ```sql
  update fighter_private set legal_name = 'Erased', email = 'erased+' || fighter_id || '@invalid.example',
         phone = null, city = null, country = null, previous_experience = null where fighter_id = '<id>';
  update fighters set nickname = null, bio = null, hometown = null, photo_path = null, public_photo_path = null,
         public_profile_approved = false, status = 'retired' where id = '<id>';
  ```
  then delete their objects from both storage buckets. Published results keep only the fight name if required
  for sporting records; otherwise also set `fight_name = 'Former competitor'`.
- Suggested retention: rejected registrations and their documents — delete documents 12 months after the
  event; email logs — prune payloads older than 24 months; rate-limit rows are purged daily by cron.
