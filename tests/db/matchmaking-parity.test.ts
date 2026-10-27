import { afterAll, describe, expect, it } from 'vitest';
import { evaluatePair, type Candidate, type MatchRules } from '../../supabase/functions/_shared/domain/matchmaking';
import { pool, tx } from './helpers';

afterAll(() => pool.end());

// Deterministic pseudo-random generator so failures are reproducible.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

const NOW = new Date('2026-10-27T06:00:00Z');
const CLASSES = [
  { id: 'c1', name: 'Flyweight', division: 'men', min_g: null, max_g: 56699, allowed_diff_g: 1814 },
  { id: 'c2', name: 'Bantamweight', division: 'men', min_g: 56699, max_g: 61235, allowed_diff_g: 1814 },
  { id: 'c3', name: 'Lightweight', division: 'men', min_g: 65771, max_g: 70307, allowed_diff_g: 2268 },
  { id: 'c4', name: 'Welterweight', division: 'men', min_g: 70307, max_g: 77111, allowed_diff_g: 2722 },
  { id: 'c5', name: 'Strawweight', division: 'women', min_g: null, max_g: 52163, allowed_diff_g: 1814 },
  { id: 'c6', name: 'Open', division: null, min_g: 77111, max_g: 120000, allowed_diff_g: 9000 },
];

function candidate(r: () => number, i: number): Candidate {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const hasRecord = r() > 0.08;
  const wins = Math.floor(r() * 12);
  return {
    fighter_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    fight_name: pick(['Night Hawk', 'The Viper', "O'Brien", 'Asha']) + ` ${i}`,
    gym_id: pick(['g1', 'g2', 'g3', null]),
    gym_name: pick(['Iron Tide', null]),
    division: pick(['men', 'men', 'women']),
    competition_level: pick(['amateur', 'amateur', 'professional']),
    primary_style: pick(['Boxing', 'Judo', null]),
    skill_level: pick(['novice', 'intermediate', 'advanced', 'elite', null, null] as const),
    date_of_birth: r() > 0.05 ? `${1984 + Math.floor(r() * 26)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}` : null,
    registration_status: pick(['approved', 'approved', 'approved', 'submitted', 'under_review']),
    weight_g: r() > 0.06 ? 48000 + Math.floor(r() * 50000) : null,
    weight_recorded_at: pick([new Date(NOW.getTime() - Math.floor(r() * 60) * 86400000 - 3600000).toISOString(), null, NOW.toISOString()]),
    is_available: r() > 0.1,
    clearance_status: pick(['cleared', 'cleared', 'pending', 'not_required', 'not_cleared'] as const),
    record: hasRecord
      ? { kind: pick(['verified', 'self_reported'] as const), wins, losses: Math.floor(r() * 8), draws: Math.floor(r() * 3), no_contests: Math.floor(r() * 2) }
      : null,
    previous_opponents: [],
    active_bout_in_event: r() < 0.05,
    active_bouts_elsewhere: r() < 0.1 ? 1 : 0,
  };
}

describe('database matchmaking engine', () => {
  it('matches the TypeScript engine exactly on 600 randomised pairs', async () => {
    const r = rng(20261027);
    const people = Array.from({ length: 60 }, (_, i) => candidate(r, i));
    // a rematch and a same-fighter case
    people[1].previous_opponents = [people[2].fighter_id];
    const ctxs = [
      { starts_at: '2026-12-05T14:00:00Z', eligibility: { min_age: 18, max_age: 40, require_clearance: true } },
      { starts_at: null, eligibility: {} },
    ];
    const ruleSets: Partial<MatchRules>[] = [
      {},
      { require_verified_record: true, allow_rematch: true, strong_threshold: 70, possible_threshold: 40, weights: { weight: 50, experience: 10, record: 10, age: 0, skill: 30 } },
      { require_same_division: false, require_same_competition_level: false, max_weight_diff_g: 2000 },
    ];
    const cases: { a: Candidate; b: Candidate; ctx: (typeof ctxs)[number]; rules: Partial<MatchRules>; classes: typeof CLASSES }[] = [];
    for (let k = 0; k < 600; k++) {
      const a = people[Math.floor(r() * people.length)];
      let b = k === 0 ? a : people[Math.floor(r() * people.length)];
      if (k % 2 === 1) {
        // A close, realistic opponent for `a` so every scoring path and classification is exercised.
        const base = { ...a, registration_status: 'approved', is_available: true, clearance_status: 'cleared' as const, active_bout_in_event: false, weight_recorded_at: NOW.toISOString() };
        cases.push({ a: base, b: base, ctx: ctxs[0], rules: {}, classes: CLASSES });
        b = {
          ...base,
          fighter_id: `10000000-0000-4000-8000-${String(k).padStart(12, '0')}`,
          fight_name: `Opponent ${k}`,
          gym_id: r() < 0.2 ? base.gym_id : 'gx',
          weight_g: base.weight_g == null ? 70000 : base.weight_g + Math.floor((r() - 0.5) * 3000),
          skill_level: r() < 0.5 ? base.skill_level : 'advanced',
          record: base.record && { ...base.record, kind: r() < 0.5 ? 'verified' : base.record.kind, wins: Math.max(0, base.record.wins + Math.floor((r() - 0.5) * 6)), losses: base.record.losses + Math.floor(r() * 3) },
        };
        cases.push({ a: base, b, ctx: ctxs[k % 4 === 1 ? 0 : 1], rules: ruleSets[k % 3], classes: CLASSES });
        continue;
      }
      cases.push({ a, b, ctx: ctxs[k % 2], rules: ruleSets[k % 3], classes: k % 7 === 0 ? [] : CLASSES });
    }

    // Exact class boundaries: upper limit is inclusive, lower limit exclusive.
    const ready = { ...people[3], division: 'men', registration_status: 'approved', is_available: true, clearance_status: 'cleared' as const, active_bout_in_event: false, weight_recorded_at: NOW.toISOString() };
    for (const w of [56699, 56700, 61235, 61236, 70307, 70308, 77111, 77112, 120000, 120001]) {
      cases.push({ a: { ...ready, weight_g: w }, b: { ...ready, fighter_id: '20000000-0000-4000-8000-000000000001', fight_name: 'Edge', weight_g: w - 500 }, ctx: ctxs[0], rules: {}, classes: CLASSES });
    }

    await tx(async (c) => {
      const { rows } = await c.query(
        `select private.evaluate_pair(x->'a', x->'b', x->'ctx', x->'rules', x->'classes', $2::timestamptz) as e
           from jsonb_array_elements($1::jsonb) with ordinality t(x, n) order by n`,
        [JSON.stringify(cases), NOW.toISOString()],
      );
      let mismatches = 0;
      const seen = new Set(rows.map((x) => x.e.classification));
      expect([...seen].sort()).toEqual(['ineligible', 'possible_candidate', 'requires_review', 'strong_candidate']);
      rows.forEach(({ e: sql }, i) => {
        const { a, b, ctx, rules, classes } = cases[i];
        const ts = JSON.parse(JSON.stringify(evaluatePair(a, b, ctx, rules, classes, NOW)));
        const norm = (ev: typeof ts) => ({
          classification: ev.classification,
          score: ev.score,
          proposed: ev.proposed_weight_class,
          diff: ev.weight_diff_g ?? null,
          issues: ev.issues.map((x: { severity: string; code: string; fighter?: string; message: string }) => `${x.severity}:${x.code}:${x.fighter ?? ''}:${x.message}`),
          missing: ev.missing,
          explanation: ev.explanation,
          components: Object.fromEntries(
            Object.entries(ev.components as Record<string, { score: number | null; detail: string }>).map(([k, v]) => [k, [v.score == null ? null : Math.round(v.score * 1e9) / 1e9, v.detail]]),
          ),
        });
        const x = norm(sql);
        const y = norm(ts);
        try {
          expect(x).toEqual(y);
        } catch (err) {
          if (mismatches++ < 3) console.error('case', i, JSON.stringify({ a: cases[i].a, b: cases[i].b }), err);
        }
      });
      expect(mismatches).toBe(0);
    });
  });
});
