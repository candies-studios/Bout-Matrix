// POST /functions/v1/email-dispatch — drains the email outbox. Called by Supabase Cron every minute and
// nudged by other functions. Auth: header x-dispatch-secret = DISPATCH_SECRET.
// An email is marked "sent" only when Resend accepts it and returns a message id.
import { OFFER_LINK_TEMPLATES, renderEmail } from '../_shared/domain/emailTemplates.ts';
import { deriveOfferToken } from '../_shared/domain/tokens.ts';
import { adminClient, env, HttpError, json, serve, timingSafeEqual } from '../_shared/http.ts';

interface EmailRow {
  id: string;
  template: string;
  to_email: string;
  to_name: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

serve(async (req) => {
  const secret = req.headers.get('x-dispatch-secret') ?? '';
  if (!timingSafeEqual(secret, env('DISPATCH_SECRET'))) throw new HttpError(401, 'unauthorized', 'Unauthorized.');
  const db = adminClient();
  const siteUrl = env('SITE_URL').replace(/\/$/, '');
  const orgName = Deno.env.get('ORG_NAME') ?? 'Fight Desk';
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = env('EMAIL_FROM');
  let sent = 0;
  let failed = 0;

  for (let round = 0; round < 5; round++) {
    const { data, error } = await db.rpc('svc_claim_emails', { p_limit: 20 });
    if (error) throw error;
    const rows = (data ?? []) as EmailRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        if (!apiKey) throw Object.assign(new Error('RESEND_API_KEY is not configured'), { permanent: false });
        let actionUrl: string | undefined;
        if (OFFER_LINK_TEMPLATES.has(row.template)) {
          const { data: m } = await db.rpc('svc_offer_token_material', { p_offer: row.payload.offer_id });
          const mat = m as { offer_id: string; nonce: string; status: string } | null;
          if (!mat || mat.status !== 'pending') throw Object.assign(new Error('Offer is no longer open; email not sent'), { permanent: true });
          actionUrl = `${siteUrl}/offers/${await deriveOfferToken(env('OFFER_TOKEN_SECRET'), mat.offer_id, mat.nonce)}`;
        }
        const msg = renderEmail(row.template, row.payload, { siteUrl, orgName, actionUrl });
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': row.id },
          body: JSON.stringify({
            from,
            to: [row.to_name ? `${row.to_name.replace(/[<>"]/g, '')} <${row.to_email}>` : row.to_email],
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
            reply_to: Deno.env.get('EMAIL_REPLY_TO') || undefined,
            tags: [{ name: 'template', value: row.template }],
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
        if (res.ok && body.id) {
          await db.rpc('svc_email_sent', { p_id: row.id, p_provider_id: body.id });
          sent++;
        } else {
          const permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 409;
          throw Object.assign(new Error(`Resend ${res.status}: ${body.message ?? 'no message id returned'}`), { permanent });
        }
      } catch (e) {
        failed++;
        await db.rpc('svc_email_failed', {
          p_id: row.id,
          p_error: (e as Error).message,
          p_permanent: Boolean((e as { permanent?: boolean }).permanent),
        });
      }
    }
  }
  return json(req, { sent, failed });
});
