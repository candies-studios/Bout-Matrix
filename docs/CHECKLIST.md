# Feature checklist, verification status and limitations

Legend — ✅ built and covered by automated tests · 🟢 built, typechecked and smoke-rendered (UI) · 🟡 built, needs a live
Supabase/Resend/Vercel environment to verify end-to-end · ⬜ not built

Automated suite: **169 tests** (`npm run check`) — 59 database tests run as the real API roles against all
migrations, 110 unit/UI tests (domain logic, schemas, email templates, tokens, every route rendered). Edge
Functions pass `deno check` and `deno lint`. Production build succeeds with route-level code splitting.

## Phase 1 — Architecture ✅
Assumptions, architecture, data model, security model and plan: `docs/ARCHITECTURE.md`.

## Phase 2 — Foundation
| Feature | Status |
|---|---|
| React 19 + TS strict + Vite + Tailwind v4 design tokens, accessible components | 🟢 |
| 31 tables, constraints, indexes; RLS on every table; anon has no table access | ✅ |
| Roles: super admin, org admin, staff (+ per-event admin/matchmaker), coach | ✅ |
| Server-verified admin guard (`my_access`) | ✅ |
| Append-only audit log with PII redaction | ✅ |
| Admin bootstrap script | ✅ (run against the test DB) |

## Phase 3 — Registration
| Feature | Status |
|---|---|
| Fighter form (all spec fields, kg/lb, record breakdown, photo, event-required documents, declarations) | 🟢 form · ✅ schema · ✅ DB |
| Coach & gym form (roster, verification info) | 🟢 · ✅ |
| Permanent fighter IDs (prefix configurable, concurrency-safe, never reused) | ✅ |
| Identity reuse (ID + email + DOB), duplicate flags, admin merge | ✅ |
| Duplicate-submission protection (idempotency key) | ✅ |
| Coach-submitted registrations auto-linked to roster | ✅ |
| Signed uploads to private bucket, file type/size limits | 🟡 |
| Confirmation email with fighter ID; admin resend | ✅ queued · 🟡 delivery |
| Rate limiting, honeypot, optional Turnstile | ✅ rate limit · 🟡 Turnstile |

## Phase 4 — Event management
| Multiple events, slugs, statuses, TBA handling, branding colour | ✅ / 🟢 |
| Event-specific registration links with copy / WhatsApp / email share | 🟢 |
| Server-side validation of event & registration window; admin late override | ✅ |
| Per-event weight classes and matchmaking rules (copied from org templates) | ✅ |
| Event staff assignment and invitations | ✅ DB · 🟡 invitation email |
| Date/venue change notifications to affected fighters | ✅ |
| Announcements with opt-out | ✅ |

## Phase 5 — Matchmaking
| Engine: all 11 criteria, scores, explanations, missing info, warnings, 4 classifications | ✅ (22 unit tests) |
| Never scores on weight alone; never invents data; configurable weights/thresholds | ✅ |
| Suggestions generation & storage, filters, compare, manual matchups | 🟢 · ✅ DB |
| Bout creation re-evaluated server-side; override reason required and stored | ✅ |

## Phase 6 — Bout workflow
| Validated state machine (DB + TS parity test) | ✅ |
| One active bout per fighter per event | ✅ |
| Personal offer links (HMAC tokens, hashed at rest), view tracking, confirmation step | ✅ DB · 🟢 page |
| Accept/decline, replay & concurrency protection, decline → review, withdrawal of other offer | ✅ |
| Admin must confirm after both accept; terms changes force re-acceptance | ✅ |
| Scheduled expiry and reminders (pg_cron) | ✅ functions · 🟡 cron on hosted project |
| Replacement opponent preserving history | ✅ |
| Notifications to fighters, admins, coaches (per event setting & preferences) | ✅ queued · 🟡 delivery |

## Phase 7 — Dashboard & public site
| Dashboard metrics (RLS-scoped) | ✅ |
| Fighters (search, filters, pagination, CSV export, review, records, verification, merge) | 🟢 |
| Coaches (verify, invite, roster links), gyms | 🟢 |
| Bouts (grouped, detail, offers, history, transitions, terms) | 🟢 |
| Fight-card manager (order, segments, publish bout/card) | 🟢 · ✅ DB rules |
| Email log (status, delivery, retry, resend) | 🟢 · ✅ DB |
| Audit log viewer, settings (org, prefix, templates, rules, users, email previews) | 🟢 |
| Public events, event pages, fight card (filters, sharing, SEO tags, coming-soon) | 🟢 · ✅ privacy |
| Coach portal (roster, register fighters, password) | 🟢 |

## Phase 8 — Testing & deployment
| Automated tests, typecheck, lint (web + Deno), production build | ✅ |
| CI workflow (GitHub Actions with Postgres service) | 🟡 runs on first push |
| Deployment, email, admin bootstrap, security, backup and API docs | ✅ written |

## Limitations (honest list)
1. **Not run against live services from this build environment.** The database layer was tested on
   PostgreSQL 16 with a Supabase-compatible shim (roles, `auth.uid()`, default privileges). Supabase Storage
   policies, pg_cron scheduling, Supabase Auth invitations, Resend delivery/webhooks and Vercel headers were
   written to their documented APIs and typechecked but must be verified with `docs/MANUAL_TESTS.md`.
2. Edge Functions are typechecked/linted but have no automated HTTP tests; their logic lives mostly in tested
   SQL and shared TypeScript.
3. No browser-based end-to-end tests (Playwright could not be installed here). UI is covered by jsdom route
   smoke tests; add Playwright against staging as a next step.
4. Email templates are code (version-controlled), not editable in the admin UI; the UI previews them.
5. Fighters do not have their own login; they act via email links. A fighter self-service portal (edit
   profile, see history) would be a future addition.
6. Previous-opponent checks only know bouts recorded in this platform (`completed` status), not external history.
7. Coach "request link to an existing fighter" is admin-side only (coaches link fighters by registering them).
8. Bout results (winner/method) are not recorded yet — `completed` marks the bout only; a results module
   would feed verified records automatically.
