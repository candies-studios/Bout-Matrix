// Shared Edge Function plumbing: CORS, JSON responses, clients, auth, rate limits, spam checks.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sha256Hex } from './domain/tokens.ts';

export function env(name: string, required = true): string {
  const v = Deno.env.get(name);
  if (!v && required) throw new HttpError(500, 'server_misconfigured', `Server is missing ${name}.`);
  return v ?? '';
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function allowedOrigin(req: Request): string {
  const origin = req.headers.get('origin') ?? '';
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('SITE_URL') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (allowed.length === 0) return '*';
  return allowed.includes(origin) ? origin : allowed[0];
}

export function corsHeaders(req: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Wrap a handler with CORS, method checks and safe error reporting (no stack traces or secrets). */
export function serve(handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.code, message: e.message }, e.status);
      const pg = dbError(e);
      if (pg) return json(req, { error: pg.code, message: pg.message }, pg.status);
      console.error('unhandled', e instanceof Error ? e.message : e);
      return json(req, { error: 'internal', message: 'Something went wrong. Please try again.' }, 500);
    }
  });
}

/** Map errors raised by our SQL functions (hint = code) to HTTP responses. */
export function dbError(e: unknown): { status: number; code: string; message: string } | null {
  const err = e as { hint?: string; message?: string; code?: string };
  if (!err || typeof err !== 'object' || !('message' in err)) return null;
  const map: Record<string, number> = {
    forbidden: 403, event_not_found: 404, registration_closed: 409, identity_mismatch: 409, division_not_allowed: 400,
    invalid: 400, ineligible: 409, override_required: 409,
  };
  if (err.hint && map[err.hint]) return { status: map[err.hint], code: err.hint, message: err.message ?? err.hint };
  if (err.code === '23505') return { status: 409, code: 'conflict', message: 'This conflicts with an existing record.' };
  if (err.code === '23514' || err.code === 'P0001') return { status: 400, code: 'invalid', message: err.message ?? 'Invalid request.' };
  return null;
}

export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 64_000): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request too large.');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be JSON.');
  }
}

let _admin: SupabaseClient | null = null;
/** Service-role client. NEVER return its results unfiltered to callers. */
export function adminClient(): SupabaseClient {
  _admin ??= createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

/** Client acting as the caller, so RLS applies. */
export function userClient(req: Request): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

/** Verified user id from the caller's JWT (signature checked by Supabase Auth), or null for anonymous. */
export async function optionalUser(req: Request): Promise<string | null> {
  const token = bearer(req);
  if (!token || token === Deno.env.get('SUPABASE_ANON_KEY')) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

export async function requireUser(req: Request): Promise<string> {
  const uid = await optionalUser(req);
  if (!uid) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
  return uid;
}

export function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';
}

export async function ipHash(req: Request): Promise<string> {
  return await sha256Hex(`${env("IP_HASH_SALT")}:${clientIp(req)}`);
}

export async function rateLimit(req: Request, name: string, limit: number, windowSeconds: number) {
  const bucket = `${name}:${await ipHash(req)}`;
  const { data, error } = await adminClient().rpc('svc_rate_limit', { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) throw error;
  if (data !== true) throw new HttpError(429, 'rate_limited', 'Too many requests. Please wait a few minutes and try again.');
}

/** Cloudflare Turnstile, enforced only when TURNSTILE_SECRET_KEY is configured. */
export async function verifyHuman(req: Request, token: unknown) {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  if (!secret) return;
  if (typeof token !== 'string' || !token) throw new HttpError(400, 'captcha_required', 'Please complete the verification check.');
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  form.append('remoteip', clientIp(req));
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = (await r.json()) as { success?: boolean };
  if (!out.success) throw new HttpError(400, 'captcha_failed', 'Verification failed. Please try again.');
}

/** Best-effort: nudge the email dispatcher so confirmations go out promptly (cron is the safety net). */
export function kickDispatcher() {
  const url = `${env('SUPABASE_URL')}/functions/v1/email-dispatch`;
  const p = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dispatch-secret': env('DISPATCH_SECRET') },
    body: '{}',
  }).catch(() => undefined);
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
