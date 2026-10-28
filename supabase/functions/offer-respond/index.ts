// POST /functions/v1/offer-respond — { token, fighter_code, password, response: 'accept'|'decline', reason? }.
// Same routine as the app (public.public_respond_offer): login required; replays, double clicks and concurrent
// answers are rejected in the database (row locks + one response per offer).
import { z } from 'zod';
import { adminClient, HttpError, json, kickDispatcher, rateLimit, readJson, serve } from '../_shared/http.ts';

const Body = z.object({
  token: z.string().max(100),
  fighter_code: z.string().max(40),
  password: z.string().max(20),
  response: z.enum(['accept', 'decline']),
  reason: z.string().trim().max(1000).optional(),
});

serve(async (req) => {
  await rateLimit(req, 'offer-respond', 20, 600);
  const parsed = Body.safeParse(await readJson(req, 4000));
  if (!parsed.success) throw new HttpError(400, 'invalid', 'Invalid response.');
  const { token, fighter_code, password, response, reason } = parsed.data;
  const { data, error } = await adminClient().rpc('public_respond_offer', {
    p_token: token, p_response: response, p_reason: reason ?? null, p_fighter_code: fighter_code, p_password: password,
  });
  if (error) throw error;
  const r = data as { ok: boolean; code?: string };
  if (r.ok) kickDispatcher();
  return json(req, r, r.ok ? 200 : 409);
});
