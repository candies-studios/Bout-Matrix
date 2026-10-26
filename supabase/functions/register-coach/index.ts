// POST /functions/v1/register-coach — public coach & gym registration. Always answers neutrally.
import { CoachRegistrationSchema, fieldErrors } from '../_shared/domain/schemas.ts';
import { adminClient, json, kickDispatcher, rateLimit, readJson, serve, verifyHuman } from '../_shared/http.ts';

serve(async (req) => {
  await rateLimit(req, 'register-coach', 5, 3600);
  const body = await readJson(req);
  await verifyHuman(req, body.captcha_token);
  const parsed = CoachRegistrationSchema.safeParse(body);
  if (!parsed.success) return json(req, { error: 'validation', fields: fieldErrors(parsed.error) }, 400);
  const { consent_data: _c, website: _w, ...payload } = parsed.data;
  const { error } = await adminClient().rpc('svc_register_coach', { p: payload });
  if (error) throw error;
  kickDispatcher();
  return json(req, { status: 'received' });
});
