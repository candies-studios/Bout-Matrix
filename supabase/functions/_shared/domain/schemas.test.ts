import { describe, expect, it } from 'vitest';
import { CoachRegistrationSchema, FighterRegistrationSchema, fieldErrors } from './schemas.ts';

const valid = {
  submission_key: '6f1c2b8e-1d2a-4e5f-9a7b-1c2d3e4f5a6b',
  event_slug: 'demo-fight-night-1',
  legal_name: 'Asha Verma',
  fight_name: 'Asha "The Storm" Verma',
  date_of_birth: '1999-02-03',
  email: 'Asha@Example.com',
  phone_country_code: '+91',
  phone: '98765 43210',
  city: 'Pune',
  country: 'India',
  division: 'women',
  competition_level: 'amateur',
  gym_name: 'Northgate',
  wins: '3', losses: '1', draws: '0', no_contests: '0',
  weight_value: '56.2', weight_unit: 'kg',
  consent_data: true, consent_rules: true,
};

describe('fighter registration schema', () => {
  it('accepts a valid form and normalises values', () => {
    const r = FighterRegistrationSchema.parse(valid);
    expect(r.email).toBe('asha@example.com');
    expect(r.wins).toBe(3);
    expect(r.documents).toEqual([]);
  });
  it.each([
    [{ email: 'nope' }, 'email'],
    [{ phone_country_code: '91' }, 'phone_country_code'],
    [{ date_of_birth: '2020-01-01' }, 'date_of_birth'],
    [{ weight_value: '300', weight_unit: 'kg' }, 'weight_value'],
    [{ wins: '-1' }, 'wins'],
    [{ ko_tko_wins: '5' }, 'ko_tko_wins'],
    [{ consent_data: false }, 'consent_data'],
    [{ gym_name: '' }, 'gym_name'],
    [{ website: 'http://spam' }, 'website'],
    [{ division: 'other' }, 'division'],
    [{ existing_fighter_code: 'abc' }, 'existing_fighter_code'],
  ])('rejects %o', (over, field) => {
    const r = FighterRegistrationSchema.safeParse({ ...valid, ...over });
    expect(r.success).toBe(false);
    expect(Object.keys(fieldErrors(r.error!))).toContain(field);
  });
  it('accepts kilograms only', () => {
    expect(FighterRegistrationSchema.parse({ ...valid, weight_unit: undefined }).weight_unit).toBe('kg');
    expect(FighterRegistrationSchema.safeParse({ ...valid, weight_value: '125', weight_unit: 'lb' }).success).toBe(false);
    expect(FighterRegistrationSchema.safeParse({ ...valid, weight_value: '30' }).success).toBe(false);
  });
  it('requires the nickname and limits fighting style to the list', () => {
    expect(Object.keys(fieldErrors(FighterRegistrationSchema.safeParse({ ...valid, fight_name: '' }).error!))).toContain('fight_name');
    expect(FighterRegistrationSchema.safeParse({ ...valid, primary_style: 'Muay Thai (Thai Boxing)' }).success).toBe(true);
    expect(FighterRegistrationSchema.safeParse({ ...valid, primary_style: '' }).success).toBe(true);
    expect(FighterRegistrationSchema.safeParse({ ...valid, primary_style: 'Capoeira' }).success).toBe(false);
  });
  it('rejects document paths outside the pending upload area', () => {
    const r = FighterRegistrationSchema.safeParse({ ...valid, documents: [{ kind: 'id_card', path: '../../etc/passwd', mime_type: 'application/pdf', size_bytes: 10 }] });
    expect(r.success).toBe(false);
  });
});

describe('coach registration schema', () => {
  it('validates required fields', () => {
    const r = CoachRegistrationSchema.safeParse({ submission_key: valid.submission_key, full_name: 'A', email: 'x' });
    expect(r.success).toBe(false);
    const ok = CoachRegistrationSchema.safeParse({
      submission_key: valid.submission_key, full_name: 'Coach Ravi', email: 'ravi@example.com', phone_country_code: '+91',
      phone: '9876543210', gym_name: 'Iron Tide', city: 'Mumbai', country: 'India', coaching_experience_years: '6',
      roster: ['Fighter One'], consent_data: true,
    });
    expect(ok.success).toBe(true);
  });
});
