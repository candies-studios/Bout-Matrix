import { z } from 'zod';

// Only PUBLIC values may live here. The anon key is designed to be public; RLS protects data.
// Never add the service-role key or any provider secret to a VITE_ variable.
const EnvSchema = z.object({
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(20),
  VITE_SITE_URL: z.url().optional(),
});

export type PublicEnv = z.infer<typeof EnvSchema>;

export function readEnv(source: Record<string, unknown> = import.meta.env): { ok: true; env: PublicEnv } | { ok: false; error: string } {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    return { ok: false, error: `Missing or invalid configuration: ${missing}. Copy .env.example to .env.local.` };
  }
  const key = parsed.data.VITE_SUPABASE_ANON_KEY;
  // Defence in depth: refuse to start if someone pastes a service-role key into the browser bundle.
  if (looksLikeServiceRoleKey(key)) {
    return { ok: false, error: 'VITE_SUPABASE_ANON_KEY is a service-role key. Use the anon/publishable key.' };
  }
  return { ok: true, env: parsed.data };
}

export function looksLikeServiceRoleKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}
