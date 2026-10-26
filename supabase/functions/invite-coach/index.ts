// POST /functions/v1/invite-coach — { coach_id } org admin invites a verified coach to the coach portal.
import { z } from 'zod';
import { adminClient, env, HttpError, json, readJson, requireUser, serve, userClient } from '../_shared/http.ts';

serve(async (req) => {
  const uid = await requireUser(req);
  const parsed = z.object({ coach_id: z.uuid() }).safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid', 'coach_id is required.');

  // Authorisation as the caller (RLS): only org admins can read the coach and are org admins of its org.
  const asUser = userClient(req);
  const { data: coach } = await asUser.from('coaches').select('id, org_id, email, user_id, verification_status').eq('id', parsed.data.coach_id).maybeSingle();
  const { data: access } = await asUser.rpc('my_access');
  const a = access as { is_super_admin: boolean; org_roles: { org_id: string; role: string }[] } | null;
  if (!coach || !a || !(a.is_super_admin || a.org_roles.some((r) => r.org_id === coach.org_id && r.role === 'org_admin')))
    throw new HttpError(403, 'forbidden', 'Only organisation administrators can invite coaches.');
  if (coach.verification_status !== 'verified') throw new HttpError(409, 'invalid', 'Verify the coach first.');
  if (coach.user_id) throw new HttpError(409, 'invalid', 'This coach already has an account.');

  const db = adminClient();
  const { data, error } = await db.auth.admin.inviteUserByEmail(coach.email, { redirectTo: `${env('SITE_URL').replace(/\/$/, '')}/coach` });
  if (error || !data.user) throw new HttpError(409, 'invite_failed', error?.message ?? 'Invitation failed. The email may already have an account.');
  const { error: e2 } = await db.rpc('svc_link_coach_user', { p_actor: uid, p_coach: coach.id, p_user: data.user.id });
  if (e2) throw e2;
  return json(req, { invited: true });
});
