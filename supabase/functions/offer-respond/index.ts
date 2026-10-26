// POST /functions/v1/offer-respond — { token, response: 'accept'|'decline', reason? }.
// Replays, double clicks and concurrent answers are rejected in the database (row locks + one response per offer).
import { z } from 'zod';
import { isWellFormedToken, sha256Hex } from '../_shared/domain/tokens.ts';
import { adminClient, HttpError, ipHash, json, kickDispatcher, rateLimit, readJson, serve } from '../_shared/http.ts';

const Body = z.object({
  token: z.string().refine(isWellFormedToken),
  response: z.enum(['accept', 'decline']),
  reason: z.string().trim().max(1000).optional(),
});

serve(async (req) => {
  await rateLimit(req, 'offer-respond', 20, 600);
  const parsed = Body.safeParse(await readJson(req, 4000));
  if (!parsed.success) throw new HttpError(400, 'invalid', 'Invalid response.');
  const { token, response, reason } = parsed.data;
  const { data, error } = await adminClient().rpc('svc_respond_offer', {
    p_token_hash: await sha256Hex(token),
    p_response: response,
    p_reason: reason ?? null,
    p_ip_hash: await ipHash(req),
    p_user_agent: req.headers.get('user-agent') ?? '',
  });
  if (error) throw error;
  const r = data as { ok: boolean; code?: string };
  if (r.ok) kickDispatcher();
  return json(req, r, r.ok ? 200 : 409);
});
