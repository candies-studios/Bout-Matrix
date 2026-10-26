# Security & privacy checklist

✅ = enforced and covered by automated tests · 🔧 = configuration you must apply · 📝 = process

## Access control
- ✅ Row Level Security enabled on every table (test asserts no table lacks it).
- ✅ Anonymous role has **no** table privileges (test tries every table). Public data comes only from
  `public_*` SECURITY DEFINER functions that return whitelisted columns of published records.
- ✅ Event staff see only assigned events; an event assignment without an org staff role grants nothing.
- ✅ Matchmakers cannot confirm, cancel or publish bouts, approve registrations or send announcements.
- ✅ Coaches see only fighters on their **approved** roster; unverified coaches see nothing; coaches cannot
  approve their own roster links.
- ✅ Org admins cannot grant `super_admin` or act in other organisations.
- ✅ Every SECURITY DEFINER function pins `search_path` (test asserts it).
- ✅ Privileged functions (`svc_*`) are executable by the service role only; Edge Functions verify the
  caller's JWT with Supabase Auth and pass the verified user id; permissions are re-checked in SQL.
- ✅ The frontend never decides permissions: UI gates use `my_access()` from the server and every query is
  still filtered by RLS.
- 🔧 Supabase Auth sign-ups disabled; strong password policy (Auth → Providers → Email → minimum length 12).
- 🔧 Enable MFA for administrators (Auth → Multi-factor) — recommended.

## Secrets
- ✅ Browser bundle contains only the anon key; the app refuses to start if a service-role key is configured.
- ✅ `.env*` files are git-ignored; `.env.example` has placeholders only.
- 🔧 Edge Function secrets set with `supabase secrets set`; rotate `RESEND_API_KEY`, `DISPATCH_SECRET` yearly.

## Offer links
- ✅ 256-bit tokens = HMAC(secret, offer id ‖ nonce); database stores only `sha256(token)` and the nonce;
  token hash/nonce columns are not selectable via the API.
- ✅ One response per offer (unique constraint + row locks): replays, double-clicks and concurrent answers
  are rejected; superseded, revoked, withdrawn and expired offers cannot be answered.
- ✅ Recipients see only their own offer and the opponent's non-private profile (no email, phone, DOB, legal name).
- ✅ Offer pages are `noindex`, `Cache-Control: no-store`, `Referrer-Policy: strict-origin`.

## Abuse protection
- ✅ Rate limits per hashed IP: fighter registration 10/h, coach 5/h, uploads 20/h, offer views 60/10 min,
  responses 20/10 min.
- ✅ Honeypot field on public forms; 🔧 optional Cloudflare Turnstile (`VITE_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`).
- ✅ Idempotent submissions (`submission_key`) prevent duplicates from retries.
- ✅ Coach registration answers identically for new and existing emails (no account enumeration).
- ✅ Input validated with Zod in the browser **and** in Edge Functions, and constrained again by SQL CHECKs.

## Files
- ✅ Uploads go to a private bucket via one-time signed URLs; type (JPG/PNG/WEBP/PDF) and size (10 MB,
  photos 5 MB) enforced by the function and the bucket; paths must match `pending/<uuid>/<kind>.<ext>`.
- ✅ Staff read files only through short-lived signed URLs, and only for records they may see (storage policy).
- ✅ Photos become public only after an admin approves the profile (copied to `public-media`).

## Privacy
- ✅ No medical records collected — only a clearance status.
- ✅ Private details (legal name, DOB, email, phone) live in `fighter_private`, never in public functions
  (tests check the fight card and offer payloads for leaks).
- ✅ Audit log redacts personal values (records only that they changed).
- ✅ Emails never contain tokens in stored payloads (CHECK constraint), passwords or medical data.
- ✅ CSV export guards against spreadsheet formula injection.
- 📝 Data retention: see `docs/BACKUP.md` → "Retention and erasure".

## Auditability
- ✅ Audit log is append-only: no UPDATE/DELETE privilege, plus triggers that block UPDATE, DELETE and
  TRUNCATE even for the table owner.
- ✅ Bout status history and offer responses are append-only.
- ✅ Reasons are mandatory for cancellations, reviews, rejections, overrides, reopenings and merges.

## Web
- ✅ Content-Security-Policy, HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'` (vercel.json).
- ✅ Edge Functions restrict CORS to `ALLOWED_ORIGINS`, return generic errors (no stack traces).

## Not yet verified
- Behaviour against a hosted Supabase project, Resend and Vercel has not been exercised end-to-end from this
  build environment (see CHECKLIST.md → Limitations). Run the go-live checklist in DEPLOYMENT.md.
