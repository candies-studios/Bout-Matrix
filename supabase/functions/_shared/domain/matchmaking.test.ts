import { describe, expect, it } from 'vitest';
import { evaluatePair, generateSuggestions, resolveRules, type Candidate } from './matchmaking.ts';
import { GRAMS_PER_LB } from './weights.ts';

const lb = (n: number) => Math.round(n * GRAMS_PER_LB);
const classes = [
  { id: 'lw', name: 'Lightweight', division: 'men', min_g: lb(145), max_g: lb(155), allowed_diff_g: lb(5) },
  { id: 'ww', name: 'Welterweight', division: 'men', min_g: lb(155), max_g: lb(170), allowed_diff_g: lb(6) },
];
const now = new Date('2026-10-26T00:00:00Z');
const ctx = { starts_at: '2026-12-01T14:00:00Z', eligibility: { min_age: 18, max_age: 40, require_clearance: true } };

let n = 0;
function f(over: Partial<Candidate> = {}): Candidate {
  n++;
  return {
    fighter_id: `f${n}`,
    fight_name: `Fighter ${n}`,
    gym_id: `g${n}`,
    division: 'men',
    competition_level: 'amateur',
    date_of_birth: '1998-05-05',
    registration_status: 'approved',
    weight_g: 70000,
    weight_recorded_at: '2026-10-20T00:00:00Z',
    is_available: true,
    clearance_status: 'cleared',
    record: { kind: 'verified', wins: 4, losses: 1, draws: 0, no_contests: 0 },
    skill_level: 'intermediate',
    ...over,
  };
}
const ev = (a: Candidate, b: Candidate, rules = {}) => evaluatePair(a, b, ctx, rules, classes, now);

describe('matchmaking engine', () => {
  it('classifies an evenly matched pair as a strong candidate with an explanation', () => {
    const e = ev(f(), f({ weight_g: 70300, record: { kind: 'verified', wins: 3, losses: 1, draws: 0, no_contests: 0 } }));
    expect(e.classification).toBe('strong_candidate');
    expect(e.score).toBeGreaterThan(75);
    expect(e.proposed_weight_class?.name).toBe('Lightweight');
    expect(e.explanation.join(' ')).toMatch(/Weights .* apart/);
    expect(e.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('never matches on weight alone: missing record ⇒ no score, requires review', () => {
    const e = ev(f({ record: null }), f());
    expect(e.score).toBeNull();
    expect(e.classification).toBe('requires_review');
    expect(e.missing.join()).toMatch(/fight record/);
  });

  it('blocks weight gaps beyond the class allowance', () => {
    const e = ev(f({ weight_g: lb(145) }), f({ weight_g: lb(152) }));
    expect(e.classification).toBe('ineligible');
    expect(e.issues.map((i) => i.code)).toContain('weight_gap');
  });

  it.each([
    ['division', { division: 'women' }, 'division_mismatch'],
    ['level', { competition_level: 'professional' }, 'level_mismatch'],
    ['unapproved', { registration_status: 'submitted' }, 'registration_not_approved'],
    ['unavailable', { is_available: false }, 'unavailable'],
    ['too young', { date_of_birth: '2010-01-01' }, 'too_young'],
    ['too old', { date_of_birth: '1970-01-01' }, 'too_old'],
    ['not cleared', { clearance_status: 'not_cleared' as const }, 'not_cleared'],
    ['conflict', { active_bout_in_event: true }, 'conflict_same_event'],
    ['experience', { record: { kind: 'verified' as const, wins: 14, losses: 2, draws: 0, no_contests: 0 } }, 'experience_gap'],
  ])('blocks %s', (_l, over, code) => {
    const e = ev(f(), f(over as Partial<Candidate>));
    expect(e.classification).toBe('ineligible');
    expect(e.issues.map((i) => i.code)).toContain(code);
  });

  it('flags for review rather than inventing data', () => {
    const cases: [Partial<Candidate>, string][] = [
      [{ weight_g: null }, 'weight_missing'],
      [{ weight_recorded_at: '2026-01-01T00:00:00Z' }, 'weight_stale'],
      [{ date_of_birth: null }, 'age_unknown'],
      [{ clearance_status: 'pending' }, 'clearance_pending'],
    ];
    for (const [over, code] of cases) {
      const e = ev(f(), f(over));
      expect(e.classification, code).toBe('requires_review');
      expect(e.issues.map((i) => i.code)).toContain(code);
    }
  });

  it('flags teammates and rematches', () => {
    const a = f({ gym_id: 'same', gym_name: 'Iron Tide' });
    const b = f({ gym_id: 'same' });
    expect(ev(a, b).issues.map((i) => i.code)).toContain('same_gym');
    const c = f();
    const d = f({ previous_opponents: [c.fighter_id] });
    expect(ev(c, d).classification).toBe('ineligible');
    expect(ev(c, d, { allow_rematch: true }).classification).not.toBe('ineligible');
  });

  it('respects configurable rules', () => {
    const a = f({ record: { kind: 'self_reported', wins: 2, losses: 0, draws: 0, no_contests: 0 } });
    const b = f({ record: { kind: 'self_reported', wins: 2, losses: 1, draws: 0, no_contests: 0 } });
    expect(ev(a, b).classification).not.toBe('requires_review');
    expect(ev(a, b, { require_verified_record: true }).classification).toBe('requires_review');
    expect(resolveRules({ weights: { weight: 50 } as never }).weights.experience).toBe(25);
  });

  it('uses today for ages when the event date is TBA and says so', () => {
    const e = evaluatePair(f(), f(), { starts_at: null }, {}, classes, now);
    expect(e.issues.map((i) => i.code)).toContain('event_date_tba');
  });

  it('generates sorted suggestions and drops ineligible by default', () => {
    const pool = [f(), f({ weight_g: 70500 }), f({ division: 'women' }), f({ weight_g: 69800, record: { kind: 'verified', wins: 0, losses: 0, draws: 0, no_contests: 0 } })];
    const s = generateSuggestions(pool, ctx, {}, classes, { now });
    expect(s.every((x) => x.classification !== 'ineligible')).toBe(true);
    expect(s[0].classification).toBe('strong_candidate');
    const all = generateSuggestions(pool, ctx, {}, classes, { now, includeIneligible: true });
    expect(all.length).toBe(6);
  });
});
