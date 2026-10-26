// POST /functions/v1/fighter-profile-approval — { fighter_id, approve } publishes or withdraws the public profile
// (photo copied from the private bucket into public-media only on approval).
import { z } from 'zod';
import { adminClient, HttpError, json, readJson, requireUser, serve, userClient } from '../_shared/http.ts';

serve(async (req) => {
  await requireUser(req);
  const parsed = z.object({ fighter_id: z.uuid(), approve: z.boolean() }).safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid', 'fighter_id and approve are required.');
  const { fighter_id, approve } = parsed.data;

  // The update runs as the caller: RLS allows it only for users who may edit this fighter, and it is audited.
  const { data: rows, error } = await userClient(req)
    .from('fighters').update({ public_profile_approved: approve }).eq('id', fighter_id).select('id, photo_path, public_photo_path');
  if (error) throw error;
  if (!rows?.length) throw new HttpError(403, 'forbidden', 'You cannot edit this fighter.');
  const f = rows[0] as { id: string; photo_path: string | null; public_photo_path: string | null };
  const db = adminClient();

  if (approve && f.photo_path) {
    const { data: blob, error: dErr } = await db.storage.from('registration-private').download(f.photo_path);
    if (dErr || !blob) throw new HttpError(500, 'photo_unavailable', 'Could not read the uploaded photo.');
    const ext = f.photo_path.split('.').pop();
    const dest = `fighters/${f.id}-${Date.now()}.${ext}`;
    const { error: uErr } = await db.storage.from('public-media').upload(dest, blob, { contentType: blob.type, upsert: false });
    if (uErr) throw uErr;
    if (f.public_photo_path) await db.storage.from('public-media').remove([f.public_photo_path]);
    await db.from('fighters').update({ public_photo_path: dest }).eq('id', f.id);
  } else if (!approve && f.public_photo_path) {
    await db.storage.from('public-media').remove([f.public_photo_path]);
    await db.from('fighters').update({ public_photo_path: null }).eq('id', f.id);
  }
  return json(req, { approved: approve });
});
