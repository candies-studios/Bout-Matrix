# Manual verification script

Run after deploying to a staging project (or locally with `supabase start`, `supabase db reset`
— which loads the synthetic seed — and `supabase functions serve`). Use inboxes you control.

## Phase 2 — Foundation
1. `/admin/login` with a non-admin account → "no administrator access" message, no dashboard.
2. Bootstrap admin → dashboard loads with counts.
3. In the browser devtools, call `supabase.from('fighter_private').select('*')` while signed out → permission error.

## Phase 3 — Registration
1. Admin → Events → Demo Fight Night 1 → Registration links → open the fighter link in a private window.
2. Submit with empty fields → errors next to each field; focus moves to the first error.
3. Submit valid data with a photo → success page shows `WDS-F-####`; email arrives with the same ID.
4. Click submit twice quickly / refresh and resubmit → no duplicate fighter (same ID shown).
5. Register again with "I already have a fighter ID" + same email/DOB for another event → status "reused".
   Wrong DOB → "We could not match…".
6. Register a new profile with the same email → Admin → Fighters → profile shows a duplicate flag; merge it.
7. Coach registration → Admin → Coaches → verify → Invite → coach receives invite, sets password at `/coach`,
   registers a fighter → fighter appears on the coach's roster only.

## Phase 4 — Events
1. Create event (hidden draft) → try to tick "Show publicly" while draft → error.
2. Leave date/venue blank → public page shows "To Be Announced".
3. Edit weight classes and rules; change venue of an event with an active offer → both fighters get an
   "Event details changed" email.
4. Set registration closed → fighter link shows "Registration closed".

## Phase 5 — Matchmaking
1. Approve 6+ registrations with mixed weights/divisions → Generate suggestions.
2. Check: different divisions never appear; a pair 10 kg apart is not suggested; missing record →
   "Requires review" with no score.
3. Manual matchup of an ineligible pair → Create requires an override reason; reason visible on the bout.

## Phase 6 — Bout workflow
1. Send offers → two emails with different personal links.
2. Open link A → bout shows "Awaiting responses"; page shows opponent's public info only.
3. Accept A (confirmation step) → reload → "already responded". Accept B → bout "Accepted by both fighters"
   (not confirmed). Admin gets "Both accepted" email.
4. Confirm bout → both fighters emailed.
5. New bout: decline one → other link shows "withdrawn"; bout "Declined" → Replace an opponent.
6. Set expiry to 1 hour, wait (or update `expires_at` in SQL) → cron marks it expired within 5 minutes.
7. Move a confirmed bout to review → it disappears from the public card; old links show "withdrawn".

## Phase 7 — Dashboard & public site
1. Fight cards → publish bouts, reorder, set segments, publish card → public card matches order.
2. Weight-class filter and "Coming soon" state on an event with no published bouts.
3. Emails → force a failure (temporarily set an invalid `RESEND_API_KEY`) → status failed with error → fix → Retry → sent.
4. Audit log shows each action with actor and reason; personal values show as redacted.

## Phase 8 — Security spot checks
1. Copy an offer link, change one character → "not valid".
2. Hit `register-fighter` 11 times in an hour from one IP → 429.
3. Build with production env vars and search the bundle for your actual service-role key value (`grep -r "<first 20 chars of the key>" dist/` must be empty). The word "service_role" itself appears harmlessly in library code and in the startup guard that rejects such keys.
