# Integration API

Other systems (a scoring app, a ranking site, a broadcast graphics tool) can integrate without touching
this codebase. Everything below is stable; breaking changes will get a new function name.

Base URL: `https://<PROJECT_REF>.supabase.co`. Every request needs the header `apikey: <anon key>`.

## 1. Public, read-only (no login)

PostgREST RPC: `POST /rest/v1/rpc/<name>` with a JSON body and headers
`apikey`, `Content-Type: application/json`.

| Function | Body | Returns |
|---|---|---|
| `public_list_events` | `{"p_scope": "upcoming" \| "past" \| "all"}` | Public events: slug, name, promotion, dates (null = TBA), venue, status, `registration_open`, `fight_card_published`. |
| `public_get_event` | `{"p_slug": "demo-fight-night-1"}` | One event incl. rules text and active weight classes (`max_g` in grams). |
| `public_get_fight_card` | `{"p_slug": "…"}` | Published, confirmed bouts in card order: `bout_code`, segment, weight class, rounds, and `fighter_a`/`fighter_b` objects (fight name, nickname, country, approved photo path, verified record, public gym). |
| `public_registration_event` | `{"p_slug": "…"}` | Registration context for forms. |
| `public_list_gyms` | `{}` | Verified public gyms. |

Photos: `photo_path` is a path in the public bucket →
`https://<PROJECT_REF>.supabase.co/storage/v1/object/public/public-media/<photo_path>`.

Example:
```bash
curl -s https://<ref>.supabase.co/rest/v1/rpc/public_get_fight_card \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" -d '{"p_slug":"demo-fight-night-1"}'
```

Guarantees: draft, pending, declined, expired and unpublished bouts are never returned; no email, phone,
date of birth, legal name, notes or tokens are ever included. `bout_code` and the event slug are stable keys.

## 2. Public actions (Edge Functions)

`POST /functions/v1/<name>` with `apikey` and `Authorization: Bearer <anon key>` (or a user JWT).
Responses are JSON; errors look like `{"error": "<code>", "message": "…", "fields"?: {…}}`.

| Function | Purpose |
|---|---|
| `registration-upload-url` | `{kind, mime_type, size_bytes}` → one-time signed upload URL in the private bucket. |
| `register-fighter` | Fighter registration (schema: `FighterRegistrationSchema` in `supabase/functions/_shared/domain/schemas.ts`). Returns `{status: created\|reused\|already_registered, fighter_code}`. Idempotent per `submission_key`. |
| `register-coach` | Coach registration (`CoachRegistrationSchema`). Always `{status: "received"}`. |
| `offer-view` / `offer-respond` | Offer page data and `{token, response: accept\|decline, reason?}`. |

Error codes: `validation` (400, with `fields`), `registration_closed` (409), `identity_mismatch` (409),
`division_not_allowed` (400), `rate_limited` (429), `captcha_required`/`captcha_failed` (400).

## 3. Authenticated integrations (staff accounts)

Create a dedicated user (Settings → Users → invite, role **staff**) and assign it to events as matchmaker or
event admin. Sign in with Supabase Auth (`/auth/v1/token?grant_type=password`) and send its JWT as
`Authorization: Bearer <jwt>`. The account can then read, via PostgREST (`/rest/v1/<table>`), exactly what
RLS allows that role — e.g. `bouts`, `event_registrations`, `fighters` for its events — and call:

| RPC / function | Purpose |
|---|---|
| `admin_overview()` | Dashboard counts scoped to the caller. |
| `transition_bout(p_bout, p_to, p_reason, p_expected_updated_at)` | `under_review`, `draft`; event admins also `confirmed`, `cancelled`, `completed` (e.g. a scoring system marking bouts completed). |
| `set_bout_published`, `set_fight_card_published` | Publication (event admins). |
| `review_registration(p_registration, p_status, p_reason, p_missing_info)` | Registration decisions. |
| `bout-create`, `bout-issue-offers`, `matchmaking-generate` (functions) | Matchmaking workflow. |

Use least privilege: a results-only integration should be an event admin of the relevant events only.

## 4. Webhooks / change feeds

Supabase Realtime can stream changes on RLS-visible tables to authenticated integrations
(`supabase.channel(...).on('postgres_changes', {schema:'public', table:'bouts'})`). For server-to-server
pushes, add a Supabase Database Webhook on `bouts` (UPDATE where `is_published` changes) pointing to your
endpoint, and sign it with a shared secret.

## 5. Data model reference

See `docs/ARCHITECTURE.md` §4 and the migrations. Weights are integer grams everywhere
(1 lb = 453.59237 g). Timestamps are UTC ISO-8601; events carry an IANA `timezone` for display.
