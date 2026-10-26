// Branded, mobile-friendly transactional emails. Every payload value is HTML-escaped.
// Never put passwords, medical data or secrets in templates; offer links are built by the dispatcher.

export interface RenderContext {
  siteUrl: string;
  orgName: string;
  /** Recipient-specific action link (offer page), when the template needs one. */
  actionUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

type P = Record<string, unknown>;

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDate(iso: unknown, tz?: unknown): string {
  if (!iso) return 'To Be Announced';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return 'To Be Announced';
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: (tz as string) || 'UTC' }).format(d) + (tz ? ` (${tz})` : ' (UTC)');
  } catch {
    return d.toUTCString();
  }
}

interface Block {
  subject: string;
  heading: string;
  lines: string[]; // already-escaped HTML fragments
  action?: { label: string; url: string };
  footnote?: string;
}

const s = escapeHtml;
const tba = (v: unknown) => (v ? s(v) : 'To Be Announced');

function boutLines(p: P): string[] {
  return [
    `<strong>Event:</strong> ${s(p.event_name)}`,
    p.opponent_name ? `<strong>Opponent:</strong> ${s(p.opponent_name)}` : '',
    p.weight_class ? `<strong>Weight class:</strong> ${s(p.weight_class)}` : '',
    p.rounds ? `<strong>Format:</strong> ${s(p.rounds)} × ${s(p.round_minutes)} min` : '',
    'starts_at' in p ? `<strong>Date:</strong> ${s(formatDate(p.starts_at, p.timezone))}` : '',
    'venue_name' in p ? `<strong>Venue:</strong> ${tba(p.venue_name)}` : '',
  ].filter(Boolean);
}

function build(template: string, p: P, ctx: RenderContext): Block {
  const site = ctx.siteUrl.replace(/\/$/, '');
  const adminBout = p.bout_id ? `${site}/admin/bouts?bout=${encodeURIComponent(String(p.bout_id))}` : `${site}/admin/bouts`;
  const eventLink = p.event_slug ? `${site}/events/${encodeURIComponent(String(p.event_slug))}` : undefined;
  const base = template.replace(/_coach$/, '');
  const coach = template.endsWith('_coach');
  const who = coach ? `your fighter ${s(p.fighter_name)}` : 'you';

  switch (template) {
    case 'fighter_registration_confirmation':
    case 'fighter_id_delivery':
      return {
        subject: `Your fighter ID: ${p.fighter_code}`,
        heading: p.reused ? 'Registration received' : 'Welcome — your fighter ID',
        lines: [
          `Hi ${s(p.fighter_name)},`,
          p.event_name ? `We received your registration for <strong>${s(p.event_name)}</strong>. It will be reviewed by the organisers.` : 'Your fighter profile has been created.',
          `Your permanent fighter ID is <span style="font-size:22px;font-weight:700;letter-spacing:1px">${s(p.fighter_code)}</span>`,
          'Keep this ID. Use it with the same email and date of birth to register for future events without creating a new profile.',
        ],
      };
    case 'coach_fighter_submitted':
      return { subject: `Fighter registered: ${p.fighter_name}`, heading: 'Fighter registered', lines: [`${s(p.fighter_name)} (${s(p.fighter_code)}) was registered${p.event_name ? ` for ${s(p.event_name)}` : ''}.`] };
    case 'coach_registration_confirmation':
      return {
        subject: 'Coach registration received',
        heading: 'Registration received',
        lines: [`Hi ${s(p.coach_name)},`, `Thanks for registering${p.event_name ? ` for ${s(p.event_name)}` : ''}. An administrator will verify your details and email you an invitation to the coach portal.`],
      };
    case 'coach_verified':
      return { subject: 'Your coach registration is verified', heading: 'You are verified', lines: [`Hi ${s(p.coach_name)}, your coach registration has been verified. You will receive a separate email to set up your account.`] };
    case 'coach_rejected':
      return { subject: 'Your coach registration', heading: 'Registration not approved', lines: [`Hi ${s(p.coach_name)}, we could not verify your registration.`, p.reason ? `Reason: ${s(p.reason)}` : ''].filter(Boolean) };
    case 'registration_approved':
      return { subject: `Approved: ${p.event_name}`, heading: 'Registration approved', lines: [`Hi ${s(p.fighter_name)} (${s(p.fighter_code)}),`, `Your registration for <strong>${s(p.event_name)}</strong> has been approved. We will contact you if a bout is offered.`], action: eventLink ? { label: 'View event', url: eventLink } : undefined };
    case 'registration_rejected':
      return { subject: `Registration update: ${p.event_name}`, heading: 'Registration not approved', lines: [`Hi ${s(p.fighter_name)},`, `Your registration for <strong>${s(p.event_name)}</strong> was not approved.`, p.reason ? `Reason: ${s(p.reason)}` : ''].filter(Boolean) };
    case 'registration_incomplete': {
      const items = Array.isArray(p.missing_info) ? p.missing_info : [];
      return {
        subject: `Information needed: ${p.event_name}`,
        heading: 'We need a little more information',
        lines: [`Hi ${s(p.fighter_name)} (${s(p.fighter_code)}),`, `To complete your registration for <strong>${s(p.event_name)}</strong>, please send:`, `<ul>${items.map((i) => `<li>${s(String(i).replace(/_/g, ' '))}</li>`).join('')}</ul>`, p.reason ? s(p.reason) : '', 'Reply to this email with the details.'].filter(Boolean),
      };
    }
    case 'bout_offer':
      return {
        subject: `Bout offer: ${p.event_name}`,
        heading: 'You have a bout offer',
        lines: [`Hi ${s(p.fighter_name)},`, 'You have been offered the following bout:', ...boutLines(p), `<strong>Respond by:</strong> ${s(formatDate(p.expires_at, p.timezone))}`, 'This link is personal to you. Do not forward it.'],
        action: ctx.actionUrl ? { label: 'Review and respond', url: ctx.actionUrl } : undefined,
      };
    case 'offer_expiry_reminder':
      return { subject: `Reminder: your bout offer expires soon`, heading: 'Your offer expires soon', lines: [`Hi ${s(p.fighter_name)}, your offer for <strong>${s(p.event_name)}</strong> expires ${s(formatDate(p.expires_at))}.`], action: ctx.actionUrl ? { label: 'Review and respond', url: ctx.actionUrl } : undefined };
    case 'offer_accepted_confirmation':
      return { subject: `You accepted: ${p.event_name}`, heading: 'Acceptance received', lines: [`Hi ${s(p.fighter_name)}, we recorded your acceptance of bout ${s(p.bout_code)}.`, 'The bout is not final until the organisers confirm it. We will email you.'] };
    case 'offer_declined_confirmation':
      return { subject: `You declined: ${p.event_name}`, heading: 'Decline received', lines: [`Hi ${s(p.fighter_name)}, we recorded that you declined bout ${s(p.bout_code)}. Thank you for letting us know.`] };
    case 'admin_offer_accepted':
    case 'admin_offer_declined':
    case 'admin_both_accepted':
    case 'admin_offer_expired':
      return {
        subject: {
          admin_offer_accepted: `Accepted: ${p.fighter_name} (${p.bout_code})`,
          admin_offer_declined: `Declined: ${p.fighter_name} (${p.bout_code}) — review needed`,
          admin_both_accepted: `Both accepted: ${p.bout_code} — awaiting your confirmation`,
          admin_offer_expired: `Offer expired: ${p.bout_code} — review needed`,
        }[template]!,
        heading: { admin_offer_accepted: 'Offer accepted', admin_offer_declined: 'Offer declined', admin_both_accepted: 'Both fighters accepted', admin_offer_expired: 'Offer expired' }[template]!,
        lines: [
          p.fighter_name ? `${s(p.fighter_name)} — bout ${s(p.bout_code)}${p.event_name ? `, ${s(p.event_name)}` : ''}.` : `Bout ${s(p.bout_code)}.`,
          p.reason ? `Reason given: ${s(p.reason)}` : '',
          template === 'admin_both_accepted' ? 'The bout is not confirmed until an administrator confirms it.' : '',
        ].filter(Boolean),
        action: { label: 'Open bout', url: adminBout },
      };
    case 'coach_offer_response':
      return { subject: `${p.fighter_name} ${p.response === 'accept' ? 'accepted' : 'declined'} a bout offer`, heading: 'Offer response', lines: [`${s(p.fighter_name)} ${p.response === 'accept' ? 'accepted' : 'declined'} bout ${s(p.bout_code)} at ${s(p.event_name)}.`] };
    default:
      break;
  }

  switch (base) {
    case 'offer_expired':
      return { subject: `Bout offer expired: ${p.event_name}`, heading: 'Offer expired', lines: [`The bout offer for ${who} (${s(p.bout_code)}, ${s(p.event_name)}) expired before both fighters responded. The organisers may contact ${coach ? 'them' : 'you'} again.`] };
    case 'bout_confirmed':
      return { subject: `Bout confirmed: ${p.event_name}`, heading: 'Your bout is confirmed', lines: [`The bout for ${who} against ${s(p.opponent_name)} at <strong>${s(p.event_name)}</strong> is confirmed (${s(p.bout_code)}).`], action: eventLink ? { label: 'View event', url: eventLink } : undefined };
    case 'bout_cancelled':
      return { subject: `Bout cancelled: ${p.event_name}`, heading: 'Bout cancelled', lines: [`The bout for ${who} (${s(p.bout_code)}) at ${s(p.event_name)} has been cancelled.`, p.reason ? `Reason: ${s(p.reason)}` : ''].filter(Boolean) };
    case 'event_updated':
      return {
        subject: `Event update: ${p.event_name}`,
        heading: 'Event details changed',
        lines: [`The details for <strong>${s(p.event_name)}</strong> have changed:`, `<strong>Date:</strong> ${s(formatDate(p.starts_at, p.timezone))}`, `<strong>Venue:</strong> ${tba(p.venue_name)}${p.venue_city ? `, ${s(p.venue_city)}` : ''}`],
        action: eventLink ? { label: 'View event', url: eventLink } : undefined,
      };
    case 'event_announcement':
      return { subject: `${p.event_name}: announcement`, heading: s(p.event_name), lines: [`Hi ${s(p.fighter_name)},`, s(p.message).replace(/\n/g, '<br>')], action: eventLink ? { label: 'View event', url: eventLink } : undefined, footnote: 'You can opt out of event announcements by replying "unsubscribe".' };
  }
  throw new Error(`Unknown email template: ${template}`);
}

export const KNOWN_TEMPLATES = [
  'fighter_registration_confirmation', 'fighter_id_delivery', 'coach_fighter_submitted', 'coach_registration_confirmation',
  'coach_verified', 'coach_rejected', 'registration_approved', 'registration_rejected', 'registration_incomplete',
  'bout_offer', 'offer_expiry_reminder', 'offer_accepted_confirmation', 'offer_declined_confirmation',
  'admin_offer_accepted', 'admin_offer_declined', 'admin_both_accepted', 'admin_offer_expired', 'coach_offer_response',
  'offer_expired', 'offer_expired_coach', 'bout_confirmed', 'bout_confirmed_coach', 'bout_cancelled', 'bout_cancelled_coach',
  'event_updated', 'event_updated_coach', 'event_announcement',
] as const;

/** Templates whose action link is a personal offer link (needs the token). */
export const OFFER_LINK_TEMPLATES = new Set(['bout_offer', 'offer_expiry_reminder']);

export function renderEmail(template: string, payload: P, ctx: RenderContext): RenderedEmail {
  const b = build(template, payload, ctx);
  const subject = b.subject.replace(/[\r\n]+/g, ' ').slice(0, 200);
  const brand = s(ctx.orgName);
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>${s(subject)}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#121214;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:1px;text-transform:uppercase">${brand}<span style="display:block;height:3px;width:40px;background:#dc2626;margin-top:8px"></span></td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:22px;color:#121214">${b.heading}</h1>
${b.lines.map((l) => (l.startsWith('<ul') ? l : `<p style="margin:0 0 12px;font-size:16px;line-height:1.5">${l}</p>`)).join('\n')}
${b.action ? `<p style="margin:24px 0"><a href="${s(b.action.url)}" style="display:inline-block;background:#b91c1c;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">${s(b.action.label)}</a></p><p style="font-size:12px;color:#71717a;word-break:break-all">${s(b.action.url)}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a">${b.footnote ? s(b.footnote) + '<br>' : ''}Sent by ${brand}. This is an automated message about your registration or bouts.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    b.heading,
    '',
    ...b.lines.map((l) => l.replace(/<li>/g, '- ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")),
    b.action ? `\n${b.action.label}: ${b.action.url}` : '',
    '',
    `— ${ctx.orgName}`,
  ].join('\n');
  return { subject, html, text };
}
