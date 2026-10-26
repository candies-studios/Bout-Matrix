// POST /functions/v1/bout-issue-offers — { bout_id, expires_in_hours? } issues one personal offer per fighter.
import { z } from 'zod';
import { deriveOfferToken, randomNonce, sha256Hex } from '../_shared/domain/tokens.ts';
import { adminClient, env, HttpError, json, kickDispatcher, readJson, requireUser, serve } from '../_shared/http.ts';

const Body = z.object({ bout_id: z.uuid(), expires_in_hours: z.number().int().min(1).max(720).optional() });

serve(async (req) => {
  const uid = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid', 'bout_id is required.');
  const db = adminClient();
  const { data: bout } = await db.from('bouts').select('id, events(offer_validity_hours)').eq('id', parsed.data.bout_id).maybeSingle();
  if (!bout) throw new HttpError(404, 'not_found', 'Bout not found.');
  const ev = bout.events as unknown as { offer_validity_hours: number } | null;
  const hours = parsed.data.expires_in_hours ?? ev?.offer_validity_hours ?? 72;
  const secret = env('OFFER_TOKEN_SECRET');

  const offers = await Promise.all(
    (['A', 'B'] as const).map(async (corner) => {
      const id = crypto.randomUUID();
      const nonce = randomNonce();
      const token = await deriveOfferToken(secret, id, nonce);
      return { id, corner, nonce, token_hash: await sha256Hex(token) };
    }),
  );
  // Permission, state and eligibility checks happen inside svc_issue_offers (one transaction).
  const { data, error } = await db.rpc('svc_issue_offers', {
    p_actor: uid,
    p_bout: parsed.data.bout_id,
    p_expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
    p_offers: offers,
  });
  if (error) throw error;
  kickDispatcher();
  return json(req, data);
});
