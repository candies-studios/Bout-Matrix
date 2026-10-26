// POST /functions/v1/email-webhook — Resend delivery events (Svix-signed). Updates delivery_status only.
import { adminClient, env, HttpError, json, serve, timingSafeEqual } from '../_shared/http.ts';

const enc = new TextEncoder();

async function verify(req: Request, body: string) {
  const id = req.headers.get('svix-id');
  const ts = req.headers.get('svix-timestamp');
  const sigs = req.headers.get('svix-signature');
  if (!id || !ts || !sigs) throw new HttpError(401, 'unauthorized', 'Missing signature.');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new HttpError(401, 'unauthorized', 'Stale webhook.');
  const secret = env('RESEND_WEBHOOK_SECRET').replace(/^whsec_/, '');
  const keyBytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${ts}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  const ok = sigs.split(' ').some((s) => timingSafeEqual(s.split(',')[1] ?? '', expected));
  if (!ok) throw new HttpError(401, 'unauthorized', 'Bad signature.');
}

const MAP: Record<string, string> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

serve(async (req) => {
  const body = await req.text();
  await verify(req, body);
  const evt = JSON.parse(body) as { type?: string; data?: { email_id?: string } };
  const status = evt.type ? MAP[evt.type] : undefined;
  if (status && evt.data?.email_id) {
    const { error } = await adminClient().rpc('svc_email_delivery', { p_provider_id: evt.data.email_id, p_status: status });
    if (error) throw error;
  }
  return json(req, { received: true });
});
