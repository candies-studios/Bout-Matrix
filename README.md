# Fight Desk — MMA matchmaking & event management

A standalone platform for fighter and coach registration, permanent fighter IDs, matchmaking, personal bout
offers, fighter responses, event administration and public fight cards — reusable across any number of events.

**Stack:** React 19 · TypeScript · Vite · Tailwind CSS · Zod · Supabase (Postgres + RLS, Auth, Edge Functions,
Storage, pg_cron) · Resend · Vercel.

| Area | Routes |
|---|---|
| Public site | `/events`, `/events/:slug`, `/events/:slug/fight-card` |
| Registration | `/register`, `/register/fighter?event=slug`, `/register/coach?event=slug`, `/register/success` |
| Fighter offers | `/offers/:token` (personal link from email) |
| Coach portal | `/coach` |
| Admin | `/admin/login`, `/admin/dashboard`, `/admin/fighters`, `/admin/coaches`, `/admin/gyms`, `/admin/events`, `/admin/matchmaking`, `/admin/bouts`, `/admin/fight-cards`, `/admin/emails`, `/admin/audit-logs`, `/admin/settings` |

## Documentation
- [Architecture & security model](docs/ARCHITECTURE.md)
- [Deployment: Supabase, email, Vercel, first admin](docs/DEPLOYMENT.md)
- [Security & privacy checklist](docs/SECURITY.md)
- [Backup, recovery & retention](docs/BACKUP.md)
- [Integration API](docs/API.md)
- [Manual verification script](docs/MANUAL_TESTS.md)
- [Feature checklist, verification status & limitations](docs/CHECKLIST.md)

## Local development

Requirements: Node 20+ (22 recommended), and for the full stack the Supabase CLI with Docker.

```bash
npm install
supabase start                      # local Supabase (Postgres, Auth, Storage, Functions)
supabase db reset                   # applies migrations + synthetic seed data
cp .env.example .env.local          # VITE_SUPABASE_URL=http://127.0.0.1:54321 and the local anon key
supabase functions serve --env-file supabase/.env.local   # Edge Functions (needs the function secrets)
npm run dev                         # http://localhost:5173
```

Create a local admin: Supabase Studio (http://127.0.0.1:54323) → Authentication → Add user, then run
`scripts/bootstrap-admin.sql` with `org_slug = 'demo'`. Local emails are captured by Inbucket
(http://127.0.0.1:54324) for Auth; transactional emails need a Resend test key.

The seed creates one demo organisation (fighter ID prefix `WDS`), a demo event with registration open,
two gyms and eight fictional, approved fighters — enough to try matchmaking immediately.

## Checks

```bash
./scripts/start-test-db.sh   # disposable PostgreSQL 16 on /tmp:54329 (no Docker needed)
npm run check                # typecheck + lint + unit/UI tests + database tests
cd supabase/functions && deno check --config deno.json */index.ts && deno lint --config deno.json
```

Database tests build a throwaway database from a Supabase-compatible shim (`supabase/tests/shim`), every
migration and the seed, then test as the real API roles (`anon`, `authenticated`, `service_role`): RLS and
event separation, concurrency-safe IDs, the bout state machine, offers (replay, expiry, decline, replacement),
email outbox retries, audit immutability and public-data privacy.

## Project layout

```
src/                              React app
  pages/public · register · admin · coach
  components/  hooks/  lib/
supabase/
  migrations/                     schema, RLS, workflows — the source of truth for security
  functions/                      Edge Functions (Deno)
    _shared/domain/               shared, tested logic: matchmaking, weights, bout states, schemas, tokens, emails
  seed.sql                        synthetic development data only
  config.toml
tests/db/                         database tests
scripts/                          test DB launcher, admin bootstrap, email-dispatch cron
docs/                             guides
```

## Key rules the system enforces
- One permanent fighter identity, separate per-event registrations; IDs are never reused.
- Matchmaking scores are decision support; a person approves every bout, and overrides need a written reason.
- A bout is public only after both fighters accept, an administrator confirms, and the bout and fight card
  are published. Any change of terms after offers requires fresh acceptance.
- Public pages and APIs expose only approved, published information.
