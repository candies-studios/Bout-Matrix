# Architecture — MMA Matchmaking & Event Management Platform

Status: implemented (phases 1–8). Verification status per feature: `docs/CHECKLIST.md`.

## 1. Repository inspection

The workspace contained no existing project, so the application was initialised from scratch
(Vite `react-ts` template). Nothing from Warriors Dream Series, ScoreHUB or FightRank is imported or
referenced; "WDS" appears only as the *default, configurable* fighter-ID prefix.

## 2. Assumptions (change any of these in `organizations` / `system_settings`, not in code)

| # | Assumption | Why |
|---|------------|-----|
| A1 | One deployment can host several organisations, but the UI assumes one primary org. | `organizations` table exists for future multi-promotion use without a rewrite. |
| A2 | Fighters do **not** get login accounts. They act through recipient-specific, revocable offer links. | Lowest friction for fighters; the spec allows "secure, recipient-specific, revocable offer token". |
| A3 | Coaches are invited to an account only after an admin verifies them. Public sign-up is disabled in Supabase Auth. | Prevents self-granted access to fighter data. |
| A4 | Canonical weight unit is **grams (integer)**. 1 lb = 453.59237 g exactly. | Avoids float drift at class boundaries. |
| A5 | Weight-class limits are inclusive upper bounds (`weight ≤ max_g`) and exclusive lower bounds (`weight > min_g`). | Matches how commissions publish limits ("up to 70.3 kg"). |
| A6 | Age is evaluated on the event date (or today if the date is TBA, flagged for review). | A fighter can age into/out of eligibility. |
| A7 | Event date/venue changes notify affected fighters but do not, by themselves, invalidate acceptances. Changes to *bout terms* (opponent, weight, rounds, rules) always require re-offer. | Spec §3 vs §8. |
| A8 | Medical data is **not collected**. Only a clearance *status* (`not_required / pending / cleared / not_cleared`) is stored per registration. | Spec §4 "do not collect unnecessary medical information". |
| A9 | "Sent" for an email means the provider accepted it and returned a message id. Delivery/bounce is a separate field updated by provider webhooks. | Spec §9. |

## 3. System overview

```
Browser (React/Vite, anon key only)
  │  public reads  ──► Postgres RPC (SECURITY DEFINER, whitelisted columns)
  │  admin reads   ──► PostgREST + RLS (user JWT)
  │  mutations     ──► Postgres RPC with in-function permission checks
  │  anonymous / secret-bearing actions ──► Edge Functions
  ▼
Supabase Edge Functions (Deno, service role + secrets)
  register-fighter · register-coach · registration-upload-url
  matchmaking-generate · bout-create · bout-issue-offers
  offer-view · offer-respond · email-dispatch · email-webhook
  invite-coach · invite-staff · fighter-profile-approval
  ▼
Postgres 16 (RLS everywhere) ── pg_cron: expire offers, reminders, email dispatch kick
Storage: `registration-private` (private), `public-media` (approved photos only)
Resend: transactional email (Idempotency-Key per email_logs row)
```

Shared, dependency-light domain code lives in `supabase/functions/_shared/domain/` and is imported by
both the Vite app (alias `@domain`) and the Edge Functions, so the matchmaking engine, weight maths,
bout state machine and Zod schemas have one implementation and one test suite.

## 4. Data model (summary — authoritative source is `supabase/migrations`)

**Identity & access**: `organizations`, `user_profiles`, `user_roles` (org-wide: `super_admin`,
`org_admin`, `staff`, `coach`), `event_admins` (event-scoped: `event_admin`, `matchmaker`).

**People**: `gyms`, `coaches`, `coach_fighters`, `fighters` (permanent identity + *public* profile
fields), `fighter_private` (legal name, DOB, email, phone — 1:1, never exposed publicly),
`fighter_records` (`self_reported` and `verified` rows), `id_counters`.

**Events**: `events`, `weight_classes` (org template rows have `event_id is null`; events copy and
edit their own), `matchmaking_rules`, `event_registrations` (per fighter per event; carries declared
weight, division, availability, clearance status), `registration_documents`.

**Bouts**: `bouts`, `bout_participants` (trigger-maintained; partial unique index makes a fighter
unable to hold two *active* bouts in the same event), `bout_offers` (one per fighter per offer
version, token **hash** only), `bout_responses` (append-only, unique per offer → no replay),
`bout_status_history`, `bout_status_transitions` (the legal state graph), `matchmaking_suggestions`.

**Ops**: `email_logs` (outbox + delivery log), `notification_preferences`, `audit_logs`
(insert-only), `system_settings`, `rate_limits`.

## 5. Key mechanisms

**Fighter IDs** — `id_counters(org_id, kind)` row is incremented with `UPDATE … RETURNING` inside the
registration transaction (row lock ⇒ serialised; transactional ⇒ an aborted registration releases its
number, which was never issued because emails only leave after commit; committed numbers are never
reused because fighters cannot be deleted and codes are immutable).
Format `{PREFIX}-F-{0000}`; uniqueness also enforced by a unique index on `fighters.fighter_code`.

**Identity reuse** — a returning fighter enters their fighter ID; the server reuses the identity only
if ID + email + date of birth all match. Otherwise a new identity is created and *possible
duplicates* (same email, or same legal name + DOB) are flagged for an admin `merge_fighters` action,
which re-points registrations/bouts and retires the losing ID (never reused).

**Duplicate submissions** — every form carries a client-generated `submission_key`; it is unique in
`event_registrations`, so a double-click or retry returns the original result.

**Bout state machine** — transitions are rows in `bout_status_transitions`; a trigger rejects any
other change and writes `bout_status_history` (actor, reason). Guards: `confirmed` requires both
current-version offers accepted; `is_published` requires `confirmed|completed`; leaving those states
auto-unpublishes. Bout *terms* may only be edited in `draft` or `under_review`; editing in
`under_review` bumps `offer_version`, superseding earlier acceptances.

**Offer tokens** — token = base64url(HMAC-SHA256(`OFFER_TOKEN_SECRET`, offer_id ‖ nonce)). The DB
stores the nonce and `sha256(token)`; it never stores the token. The email dispatcher can re-derive
the token for retries (so provider-side idempotency stays consistent), while a database leak alone
cannot produce working links. Resend/revoke = new nonce. Responses lock the bout row (`FOR UPDATE`),
check version/expiry/revocation, and insert into `bout_responses` (unique per offer).

**Email** — transactional outbox. Business transactions insert `email_logs` rows (`queued`) with a
deterministic `idempotency_key`; the dispatcher claims rows with `FOR UPDATE SKIP LOCKED`, renders,
calls Resend with the same `Idempotency-Key`, and marks `sent` only on a provider message id.
Failures back off exponentially to `failed` after N attempts; admins can retry/resend. An email
failure never rolls back the registration or response that caused it.

**Public site** — anon role has **no** table privileges. It can only execute
`public_list_events()`, `public_get_event(slug)`, `public_get_fight_card(slug)`,
`public_registration_event(slug)` and `public_list_gyms()`, which return
whitelisted columns of published data. Unpublished/draft data is therefore unreachable even with a
hand-crafted API call.

**Audit** — generic trigger on sensitive tables writes actor (`auth.uid()`), action, table, record
id, changed columns and `app.reason` (set by RPCs). `audit_logs` has no UPDATE/DELETE grant and a
trigger that raises on UPDATE/DELETE/TRUNCATE.

## 6. Security model

| Actor | How authenticated | Can do |
|-------|------------------|--------|
| Public visitor | none (anon key) | Execute public RPCs; call registration & offer Edge Functions (rate-limited, honeypot, optional Turnstile). |
| Fighter | offer token (per offer) | View *their* offer (opponent's public profile only) and respond once. |
| Coach | Supabase Auth (invited) | Read/write their gym's roster & registrations; submit fighters. |
| Matchmaker | Auth + `event_admins` | Read registrations of assigned events, generate suggestions, draft bouts, issue offers. |
| Event admin | Auth + `event_admins` | Matchmaker + approve registrations, confirm/publish bouts, edit event. |
| Org admin | Auth + `user_roles` | Everything in the org: settings, roles, audit log, merges. |
| Edge Functions | service role (server only) | Privileged writes, always after verifying the caller's JWT/permissions via DB helpers. |

Helper predicates (`private.is_org_admin`, `private.can_manage_event`, `private.can_matchmake_event`,
`private.can_view_fighter`, `private.coach_can_access_fighter`) are `SECURITY DEFINER`, `STABLE`,
`search_path = ''`, and live in a schema not exposed through the API.

## 7. Implementation plan

| Phase | Scope |
|-------|-------|
| 1 | This document, schema, security model. |
| 2 | App scaffold, design tokens, routing + auth guard, all migrations/RLS, DB test harness with a Supabase-compatible shim, domain libs (weights, state machine). |
| 3 | Registration forms + Edge Functions, fighter IDs, identity reuse, uploads, confirmation emails. |
| 4 | Event CRUD, registration links, weight-class/rule editors. |
| 5 | Matchmaking engine, suggestions UI, comparison, overrides. |
| 6 | Offers, offer pages, responses, expiry cron, notifications, confirmation. |
| 7 | Dashboard modules, audit viewer, fight-card manager, public site. |
| 8 | End-to-end verification, security review, deployment docs. |
