import { describe, expect, it } from 'vitest';
import { looksLikeServiceRoleKey, readEnv } from './env';

const jwt = (payload: object) => `x.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.y`;

describe('public environment', () => {
  it('requires the Supabase URL and anon key', () => {
    const r = readEnv({});
    expect(r.ok).toBe(false);
  });
  it('refuses a service-role key in the browser', () => {
    expect(looksLikeServiceRoleKey(jwt({ role: 'service_role' }))).toBe(true);
    expect(looksLikeServiceRoleKey('sb_secret_abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeServiceRoleKey(jwt({ role: 'anon' }))).toBe(false);
    const r = readEnv({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: jwt({ role: 'service_role', pad: 'x'.repeat(30) }) });
    expect(r.ok).toBe(false);
  });
  it('accepts a valid anon configuration', () => {
    const r = readEnv({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon', pad: 'x'.repeat(30) }) });
    expect(r.ok).toBe(true);
  });
});
