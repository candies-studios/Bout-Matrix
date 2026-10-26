import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readEnv } from './env';

const env = readEnv();

export const configError: string | null = env.ok ? null : env.error;

// When configuration is missing the app renders a setup screen instead of crashing; the client
// is never used in that state.
export const supabase: SupabaseClient = env.ok
  ? createClient(env.env.VITE_SUPABASE_URL, env.env.VITE_SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : (null as unknown as SupabaseClient);

export const siteUrl = (env.ok && env.env.VITE_SITE_URL) || (typeof window !== 'undefined' ? window.location.origin : '');

/** Turn a PostgREST/Postgres error into a message safe to show to users. */
export function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/permission denied|row-level security/i.test(msg)) return 'You do not have permission to do that.';
  if (/JWT expired|invalid JWT/i.test(msg)) return 'Your session has expired. Please sign in again.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Network error. Check your connection and try again.';
  // Messages raised deliberately by our SQL functions are written for humans; keep them.
  return msg.length < 240 ? msg : 'Something went wrong. Please try again.';
}
