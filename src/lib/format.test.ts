import { describe, expect, it } from 'vitest';
import { formatDateTime, recordText, toCsv, venueText } from './format';

describe('format helpers', () => {
  it('says To Be Announced instead of inventing dates or venues', () => {
    expect(formatDateTime(null)).toBe('To Be Announced');
    expect(venueText({ venue_name: null, venue_city: 'Mumbai' })).toBe('To Be Announced · Mumbai');
    expect(venueText({ venue_name: 'NSCI Dome', venue_city: 'Mumbai', venue_country: 'India' })).toBe('NSCI Dome, Mumbai, India');
  });
  it('formats records', () => {
    expect(recordText({ wins: 3, losses: 1, draws: 0, no_contests: 1 })).toBe('3-1-0 (1 NC)');
    expect(recordText(null)).toBe('—');
  });
  it('escapes CSV and blocks spreadsheet formula injection', () => {
    const csv = toCsv([{ a: '=HYPERLINK("x")', b: 'x,y' }]);
    expect(csv).toBe(`a,b\n"'=HYPERLINK(""x"")","x,y"`);
  });
});

describe('humanize divisions', () => {
  it('reads imported division slugs naturally', async () => {
    const { humanize } = await import('./format');
    expect(humanize('k_one_u_eighteen_women')).toBe('K1 U18 women');
    expect(humanize('mma_tourney_adult_men')).toBe('MMA tournament adult men');
    expect(humanize('mma_u_twelve_men')).toBe('MMA U12 men');
    expect(humanize('men')).toBe('Men');
    expect(humanize('registration_open')).toBe('Registration open');
  });
});
