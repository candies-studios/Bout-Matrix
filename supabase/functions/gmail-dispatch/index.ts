// gmail-dispatch — sends the queued emails (email_logs) through Gmail SMTP with an App Password.
// Called every minute by pg_cron (see the SQL setup script). No CLI needed: the bundled single-file version of
// this function (dist/gmail-dispatch.ts) is pasted into Supabase → Edge Functions → Deploy a new function → Via editor.
//
// Edge Function secrets you set in the dashboard:  GMAIL_USER (you@gmail.com)  ·  GMAIL_APP_PASSWORD (16 letters)
// Provided automatically by Supabase:              SUPABASE_URL  ·  SUPABASE_SERVICE_ROLE_KEY
// Everything else (shared secret, site address, organisation name) comes from public.svc_email_config().
import nodemailer from 'npm:nodemailer@6.9.16';
import { createClient } from 'npm:@supabase/supabase-js@2.49.1';
import { OFFER_LINK_TEMPLATES, renderEmail } from '../_shared/domain/emailTemplates.ts';

interface EmailRow { id: string; template: string; to_email: string; to_name: string | null; payload: Record<string, unknown> }
interface Config { dispatch_secret: string; site_url: string | null; org_name: string }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: cfgData, error: cfgErr } = await db.rpc('svc_email_config');
  if (cfgErr) return json({ error: 'config_unavailable' }, 500);
  const cfg = cfgData as Config;
  if (!sameSecret(req.headers.get('x-dispatch-secret') ?? '', cfg.dispatch_secret)) return json({ error: 'unauthorized' }, 401);

  const user = Deno.env.get('GMAIL_USER');
  const pass = (Deno.env.get('GMAIL_APP_PASSWORD') ?? '').replace(/\s+/g, '');
  if (!user || !pass) return json({ error: 'GMAIL_USER / GMAIL_APP_PASSWORD secrets are not set' }, 500);
  if (!cfg.site_url) return json({ error: 'site_url is not set (run the SQL setup script)' }, 500);
  const siteUrl = cfg.site_url.replace(/\/$/, '');

  // Port 465 (SSL): Supabase blocks outbound 25 and 587.
  const mail = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  let sent = 0;
  let failed = 0;

  for (let round = 0; round < 3; round++) {
    const { data, error } = await db.rpc('svc_claim_emails', { p_limit: 10 });
    if (error) return json({ error: error.message }, 500);
    const rows = (data ?? []) as EmailRow[];
    if (!rows.length) break;
    for (const row of rows) {
      try {
        let actionUrl: string | undefined;
        if (OFFER_LINK_TEMPLATES.has(row.template)) {
          const { data: m } = await db.rpc('svc_offer_token_material', { p_offer: row.payload.offer_id });
          const mat = m as { status: string; fighter_code?: string } | null;
          if (!mat || mat.status !== 'pending') throw Object.assign(new Error('Offer is no longer open; email not sent'), { permanent: true });
          actionUrl = `${siteUrl}/fighter`;
          row.payload.fighter_code ??= mat.fighter_code;
        }
        const msg = renderEmail(row.template, row.payload, { siteUrl, orgName: cfg.org_name, actionUrl });
        const info = await mail.sendMail({
          from: { name: cfg.org_name, address: user },
          to: row.to_name ? { name: row.to_name.replace(/[<>"]/g, ''), address: row.to_email } : row.to_email,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        });
        await db.rpc('svc_email_sent', { p_id: row.id, p_provider_id: info.messageId ?? `gmail-${row.id}` });
        sent++;
      } catch (e) {
        failed++;
        const code = (e as { responseCode?: number }).responseCode ?? 0;
        // 5xx SMTP replies (bad address, rejected) are permanent; auth/connection/limits are retried with back-off.
        const permanent = Boolean((e as { permanent?: boolean }).permanent) || (code >= 550 && code < 560);
        await db.rpc('svc_email_failed', { p_id: row.id, p_error: String((e as Error).message).slice(0, 1000), p_permanent: permanent });
      }
    }
  }
  return json({ sent, failed });
});
