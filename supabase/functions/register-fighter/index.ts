// POST /functions/v1/register-fighter — public fighter registration (also used by signed-in coaches/admins).
import { FighterRegistrationSchema, fieldErrors } from '../_shared/domain/schemas.ts';
import { toGrams } from '../_shared/domain/weights.ts';
import { adminClient, HttpError, json, kickDispatcher, optionalUser, rateLimit, readJson, serve, verifyHuman } from '../_shared/http.ts';

serve(async (req) => {
  await rateLimit(req, 'register-fighter', 10, 3600);
  const body = await readJson(req);
  await verifyHuman(req, body.captcha_token);
  const parsed = FighterRegistrationSchema.safeParse(body);
  if (!parsed.success) return json(req, { error: 'validation', fields: fieldErrors(parsed.error) }, 400);
  const v = parsed.data;
  const db = adminClient();

  // Who is submitting? Anonymous fighter, a verified coach, or an event administrator (late override).
  const uid = await optionalUser(req);
  let coachId: string | null = null;
  if (uid) {
    const { data: coach } = await db.from('coaches').select('id').eq('user_id', uid).eq('verification_status', 'verified').maybeSingle();
    coachId = coach?.id ?? null;
  }

  // Uploaded files must exist in the private bucket before we reference them.
  const paths = [v.photo_path, ...v.documents.map((d) => d.path)].filter(Boolean) as string[];
  for (const p of paths) {
    const dir = p.slice(0, p.lastIndexOf('/'));
    const name = p.slice(p.lastIndexOf('/') + 1);
    const { data, error } = await db.storage.from('registration-private').list(dir, { search: name });
    if (error || !data?.some((o) => o.name === name)) throw new HttpError(400, 'upload_missing', 'An uploaded file could not be found. Please upload it again.');
  }

  const { consent_data: _c1, consent_rules: _c2, website: _w, weight_value, weight_unit, ...rest } = v;
  const payload = { ...rest, weight_g: toGrams(weight_value, weight_unit), weight_unit, consent_version: 'v1' };
  const { data, error } = await db.rpc('svc_register_fighter', { p: payload, p_actor: uid, p_coach: coachId });
  if (error) throw error;
  kickDispatcher();
  const r = data as { status: string; fighter_code: string; event_name?: string; registration_status?: string };
  return json(req, { status: r.status, fighter_code: r.fighter_code, event_name: r.event_name ?? null, registration_status: r.registration_status ?? null });
});
