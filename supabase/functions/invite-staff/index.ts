// POST /functions/v1/invite-staff — { email, full_name, role: 'org_admin'|'staff', event_id?, event_role? }
// Org admins invite administrators/matchmakers. Public sign-up stays disabled.
import { z } from 'zod';
import { adminClient, env, HttpError, json, readJson, requireUser, serve } from '../_shared/http.ts';

const Body = z.object({
  email: z.email().transform((s) => s.toLowerCase()),
  full_name: z.string().trim().min(2).max(120),
  role: z.enum(['org_admin', 'staff']),
  event_id: z.uuid().optional(),
  event_role: z.enum(['event_admin', 'matchmaker']).optional(),
});

serve(async (req) => {
  const uid = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid', parsed.error.issues[0]?.message ?? 'Invalid request.');
  const db = adminClient();
  const { data: profile } = await db.from('user_profiles').select('org_id').eq('id', uid).maybeSingle();
  if (!profile?.org_id) throw new HttpError(403, 'forbidden', 'Only organisation administrators can invite staff.');
  // Permission check happens in svc_grant_staff before anything is written; invite only after it passes.
  const { error: pre } = await db.rpc('svc_can_admin_org', { p_actor: uid, p_org: profile.org_id });
  if (pre) throw pre;

  const p = parsed.data;
  let userId: string | undefined;
  const { data, error } = await db.auth.admin.inviteUserByEmail(p.email, { redirectTo: `${env('SITE_URL').replace(/\/$/, '')}/admin/login` });
  if (data?.user) userId = data.user.id;
  else {
    // Already registered: look the user up instead of failing.
    const { data: existing } = await db.from('user_profiles').select('id').eq('email', p.email).maybeSingle();
    userId = existing?.id;
    if (!userId) throw new HttpError(409, 'invite_failed', error?.message ?? 'Invitation failed.');
  }
  const { error: e2 } = await db.rpc('svc_grant_staff', {
    p_actor: uid, p_org: profile.org_id, p_user: userId, p_email: p.email, p_full_name: p.full_name, p_role: p.role,
    p_event: p.event_id ?? null, p_event_role: p.event_role ?? null,
  });
  if (e2) throw e2;
  return json(req, { invited: true });
});
