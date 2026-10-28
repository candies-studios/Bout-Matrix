// POST /functions/v1/offer-view — { token, fighter_code, password } returns the recipient's own offer.
// The app calls public.public_get_offer directly; this endpoint uses the same routine, so the fighter login
// (fighter ID + date of birth as DDMMYYYY) is always required.
import { adminClient, json, rateLimit, readJson, serve } from '../_shared/http.ts';

serve(async (req) => {
  await rateLimit(req, 'offer-view', 60, 600);
  const b = await readJson<{ token?: string; fighter_code?: string; password?: string }>(req, 2000);
  const { data, error } = await adminClient().rpc('public_get_offer', {
    p_token: b.token ?? '', p_fighter_code: b.fighter_code ?? null, p_password: b.password ?? null,
  });
  if (error) throw error;
  const r = data as { ok: boolean };
  return json(req, r, r.ok ? 200 : 404);
});
