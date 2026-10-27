import { readEnv } from './env';
import { supabase } from './supabase';

export class ApiError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/** Call one of our Edge Functions. Sends the user's session token when signed in. */
export async function callFunction<T = unknown>(name: string, body: unknown): Promise<T> {
  const env = readEnv();
  if (!env.ok) throw new ApiError(0, 'config', env.error);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? env.env.VITE_SUPABASE_ANON_KEY;
  let res: Response;
  try {
    res = await fetch(`${env.env.VITE_SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: env.env.VITE_SUPABASE_ANON_KEY },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'network',
      `Could not reach the server function "${name}". Check your connection; if this keeps happening, the Supabase Edge Functions may not be deployed yet (docs/DEPLOYMENT.md, step 3).`,
    );
  }
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(out.error ?? out.code ?? 'error'), String(out.message ?? 'Request failed.'), out.fields as Record<string, string> | undefined);
  }
  return out as T;
}

/** Upload a registration file through a one-time signed URL; returns the storage path. */
export async function uploadRegistrationFile(kind: string, file: File): Promise<{ path: string; mime_type: string; size_bytes: number }> {
  const meta = await callFunction<{ path: string; token: string }>('registration-upload-url', {
    kind,
    mime_type: file.type,
    size_bytes: file.size,
  });
  const { error } = await supabase.storage.from('registration-private').uploadToSignedUrl(meta.path, meta.token, file, { contentType: file.type });
  if (error) throw new ApiError(0, 'upload_failed', 'Upload failed. Please try again.');
  return { path: meta.path, mime_type: file.type, size_bytes: file.size };
}

export function publicMediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return supabase.storage.from('public-media').getPublicUrl(path).data.publicUrl;
}
