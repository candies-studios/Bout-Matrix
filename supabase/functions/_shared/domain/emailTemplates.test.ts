import { describe, expect, it } from 'vitest';
import { KNOWN_TEMPLATES, renderEmail } from './emailTemplates.ts';

const ctx = { siteUrl: 'https://fights.example.com', orgName: 'Demo Promotions', actionUrl: 'https://fights.example.com/offers/TOKEN' };
const payload = {
  fighter_name: 'Arjun <script>alert(1)</script>', fighter_code: 'WDS-F-0001', event_name: 'Fight Night', event_slug: 'fight-night',
  opponent_name: 'Kabir', weight_class: 'Lightweight', rounds: 3, round_minutes: 5, starts_at: null, venue_name: null,
  expires_at: '2026-11-01T10:00:00Z', bout_code: 'WDS-B-0001', bout_id: 'b1', coach_name: 'Coach', missing_info: ['profile_photo'],
  reason: 'Test', response: 'accept', message: 'Weigh-ins at 9am',
};

describe('email templates', () => {
  it.each(KNOWN_TEMPLATES)('%s renders subject, html and text', (t) => {
    const r = renderEmail(t, payload, ctx);
    expect(r.subject.length).toBeGreaterThan(5);
    expect(r.html).toContain('Demo Promotions');
    expect(r.text.length).toBeGreaterThan(10);
    expect(r.html).not.toContain('<script>');
  });
  it('shows TBA instead of inventing a date or venue', () => {
    const r = renderEmail('bout_offer', payload, ctx);
    expect(r.html).toContain('To Be Announced');
    expect(r.html).toContain('https://fights.example.com/offers/TOKEN');
  });
  it('throws for unknown templates so the dispatcher marks them failed', () => {
    expect(() => renderEmail('nope_nope', payload, ctx)).toThrow();
  });
});
