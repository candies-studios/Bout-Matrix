// POST /functions/v1/bout-issue-offers — { bout_id, expires_in_hours? } issues one personal offer per fighter.
// The app now calls public.issue_offers directly; this function remains for API clients and uses the same
// database routine, so tokens always come from the database secret.
import { z } from 'zod';
import { adminClient, HttpError, json, kickDispatcher, readJson, requireUser, serve } from '../_shared/http.ts';

const Body = z.object({ bout_id: z.uuid(), expires_in_hours: z.number().int().min(1).max(720).optional() });

serve(async (req) => {
  const uid = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid', 'bout_id is required.');
  // Permission, state and eligibility checks happen inside the database (one transaction).
  const { data, error } = await adminClient().rpc('svc_issue_offers_auto', {
    p_actor: uid,
    p_bout: parsed.data.bout_id,
    p_hours: parsed.data.expires_in_hours ?? null,
  });
  if (error) throw error;
  kickDispatcher();
  return json(req, data);
});
