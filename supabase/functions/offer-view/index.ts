// POST /functions/v1/offer-view — { token } returns the recipient's own offer (no other fighter's private data).
import { isWellFormedToken, sha256Hex } from '../_shared/domain/tokens.ts';
import { adminClient, json, rateLimit, readJson, serve } from '../_shared/http.ts';

serve(async (req) => {
  await rateLimit(req, 'offer-view', 60, 600);
  const { token } = await readJson<{ token?: string }>(req, 2000);
  if (!isWellFormedToken(token)) return json(req, { ok: false, code: 'not_found' }, 404);
  const { data, error } = await adminClient().rpc('svc_get_offer', { p_token_hash: await sha256Hex(token) });
  if (error) throw error;
  const r = data as { ok: boolean };
  return json(req, r, r.ok ? 200 : 404);
});
