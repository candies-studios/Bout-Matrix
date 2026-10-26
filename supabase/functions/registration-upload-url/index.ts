// POST /functions/v1/registration-upload-url — issues a one-time signed upload URL into the private bucket.
import { z } from 'zod';
import { adminClient, HttpError, json, rateLimit, readJson, serve } from '../_shared/http.ts';

const Body = z.object({
  kind: z.string().regex(/^[a-z_]{2,40}$/),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  size_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
});
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

serve(async (req) => {
  await rateLimit(req, 'upload-url', 20, 3600);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid', 'Unsupported file. Use JPG, PNG, WEBP or PDF up to 10 MB.');
  const { kind, mime_type, size_bytes } = parsed.data;
  if (kind === 'profile_photo' && (!mime_type.startsWith('image/') || size_bytes > 5 * 1024 * 1024))
    throw new HttpError(400, 'invalid', 'Profile photos must be JPG, PNG or WEBP up to 5 MB.');
  const path = `pending/${crypto.randomUUID()}/${kind}.${EXT[mime_type]}`;
  const { data, error } = await adminClient().storage.from('registration-private').createSignedUploadUrl(path);
  if (error) throw error;
  return json(req, { path, token: data.token, signed_url: data.signedUrl });
});
