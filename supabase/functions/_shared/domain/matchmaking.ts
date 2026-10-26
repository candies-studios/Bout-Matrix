// Matchmaking engine — decision support only. It never books a bout; a human matchmaker reviews
// every pairing, and the database refuses bouts classified "requires review"/"ineligible" without a
// recorded override reason. Pure and dependency-free so it runs in the browser, Deno and Vitest.

import { classifyWeight, weightAgeDays, type WeightClassLimits } from './weights.ts';

export type Classification = 'strong_candidate' | 'possible_candidate' | 'requires_review' | 'ineligible';
export type Severity = 'block' | 'review' | 'info';

export interface MatchRules {
  weights: { weight: number; experience: number; record: number; age: number; skill: number };
  max_weight_diff_g: number;
  require_same_division: boolean;
  require_same_competition_level: boolean;
  max_experience_gap_soft: number;
  max_experience_gap_hard: number;
  max_age_gap_years_soft: number;
  weight_stale_after_days: number;
  require_verified_record: boolean;
  allow_rematch: boolean;
  strong_threshold: number;
  possible_threshold: number;
}

export const DEFAULT_RULES: MatchRules = {
  weights: { weight: 30, experience: 25, record: 20, age: 10, skill: 15 },
  max_weight_diff_g: 4536,
  require_same_division: true,
  require_same_competition_level: true,
  max_experience_gap_soft: 3,
  max_experience_gap_hard: 8,
  max_age_gap_years_soft: 8,
  weight_stale_after_days: 30,
  require_verified_record: false,
  allow_rematch: false,
  strong_threshold: 75,
  possible_threshold: 55,
};

/** Merge stored (possibly partial / older) rules over defaults. */
export function resolveRules(stored: Partial<MatchRules> | null | undefined): MatchRules {
  return { ...DEFAULT_RULES, ...(stored ?? {}), weights: { ...DEFAULT_RULES.weights, ...(stored?.weights ?? {}) } };
}

export interface FighterRecord {
  kind: 'self_reported' | 'verified';
  wins: number;
  losses: number;
  draws: number;
  no_contests: number;
  total_fights?: number;
}

export interface Candidate {
  fighter_id: string;
  fighter_code?: string;
  fight_name: string;
  gym_id?: string | null;
  gym_name?: string | null;
  division: string;
  competition_level: string;
  primary_style?: string | null;
  skill_level?: 'novice' | 'intermediate' | 'advanced' | 'elite' | null;
  date_of_birth?: string | null;
  registration_status: string;
  weight_g: number | null;
  weight_recorded_at?: string | null;
  is_available: boolean;
  clearance_status: 'not_required' | 'pending' | 'cleared' | 'not_cleared';
  record: FighterRecord | null;
  previous_opponents?: string[];
  active_bout_in_event?: boolean;
  active_bouts_elsewhere?: number;
}

export interface EventContext {
  starts_at: string | null;
  eligibility?: { min_age?: number; max_age?: number; require_clearance?: boolean };
}

export interface Issue {
  code: string;
  message: string;
  severity: Severity;
  fighter?: 'A' | 'B';
}

export interface ComponentScore {
  score: number | null; // 0..1, null when it cannot be computed
  detail: string;
}

export interface Evaluation {
  fighter_a_id: string;
  fighter_b_id: string;
  score: number | null; // 0..100
  classification: Classification;
  proposed_weight_class: { id: string; name: string } | null;
  weight_diff_g: number | null;
  components: Record<'weight' | 'experience' | 'record' | 'age' | 'skill', ComponentScore>;
  explanation: string[];
  missing: string[];
  issues: Issue[];
}

const SKILL = { novice: 0, intermediate: 1, advanced: 2, elite: 3 } as const;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function totalFights(r: FighterRecord | null): number | null {
  if (!r) return null;
  return r.total_fights ?? r.wins + r.losses + r.draws + r.no_contests;
}

/** Win rate with draws counting half; null for fighters with no decided fights. */
export function winRate(r: FighterRecord | null): number | null {
  if (!r) return null;
  const decided = r.wins + r.losses + r.draws;
  return decided === 0 ? null : (r.wins + r.draws / 2) / decided;
}

export function ageOn(dob: string | null | undefined, on: Date): number | null {
  if (!dob) return null;
  const d = new Date(dob + (dob.length === 10 ? 'T00:00:00Z' : ''));
  if (Number.isNaN(d.getTime())) return null;
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const m = on.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export function evaluatePair(
  a: Candidate,
  b: Candidate,
  ctx: EventContext,
  rulesIn: Partial<MatchRules> | null | undefined,
  classes: readonly WeightClassLimits[],
  now: Date = new Date(),
): Evaluation {
  const rules = resolveRules(rulesIn);
  const issues: Issue[] = [];
  const missing: string[] = [];
  const explanation: string[] = [];
  const add = (severity: Severity, code: string, message: string, fighter?: 'A' | 'B') =>
    issues.push({ severity, code, message, fighter });
  const both = (fn: (c: Candidate, side: 'A' | 'B') => void) => {
    fn(a, 'A');
    fn(b, 'B');
  };

  // ---- 1. Event eligibility & availability ------------------------------------------------
  if (a.fighter_id === b.fighter_id) add('block', 'same_fighter', 'A fighter cannot be matched with themselves.');
  both((c, s) => {
    if (c.registration_status !== 'approved')
      add('block', 'registration_not_approved', `${c.fight_name}'s registration is ${c.registration_status.replace('_', ' ')}, not approved.`, s);
    if (!c.is_available) add('block', 'unavailable', `${c.fight_name} is marked unavailable.`, s);
  });

  // ---- 2. Division & competition level ---------------------------------------------------
  if (rules.require_same_division && a.division !== b.division)
    add('block', 'division_mismatch', `Different competition divisions (${a.division} vs ${b.division}).`);
  if (rules.require_same_competition_level && a.competition_level !== b.competition_level)
    add('block', 'level_mismatch', `Different competition levels (${a.competition_level} vs ${b.competition_level}).`);

  // ---- 4. Age ---------------------------------------------------------------------------
  const eventDate = ctx.starts_at ? new Date(ctx.starts_at) : null;
  if (!eventDate) add('info', 'event_date_tba', 'Event date is TBA; ages are calculated as of today.');
  const ageDate = eventDate ?? now;
  const ages = [ageOn(a.date_of_birth, ageDate), ageOn(b.date_of_birth, ageDate)] as const;
  const { min_age, max_age, require_clearance } = ctx.eligibility ?? {};
  both((c, s) => {
    const age = s === 'A' ? ages[0] : ages[1];
    if (age == null) {
      missing.push(`${c.fight_name}: date of birth`);
      add('review', 'age_unknown', `${c.fight_name}'s age cannot be determined.`, s);
      return;
    }
    if (min_age != null && age < min_age) add('block', 'too_young', `${c.fight_name} will be ${age}; minimum age is ${min_age}.`, s);
    if (max_age != null && age > max_age) add('block', 'too_old', `${c.fight_name} will be ${age}; maximum age is ${max_age}.`, s);
  });

  // ---- 9. Clearance -----------------------------------------------------------------------
  both((c, s) => {
    if (c.clearance_status === 'not_cleared') add('block', 'not_cleared', `${c.fight_name} has not been cleared to compete.`, s);
    else if (require_clearance && c.clearance_status !== 'cleared')
      add('review', 'clearance_pending', `${c.fight_name}'s clearance is still pending.`, s);
  });

  // ---- 10–11. Rematches & conflicts --------------------------------------------------------
  if (!rules.allow_rematch && (a.previous_opponents?.includes(b.fighter_id) || b.previous_opponents?.includes(a.fighter_id)))
    add('block', 'rematch', 'These fighters have met before and rematches are not allowed.');
  both((c, s) => {
    if (c.active_bout_in_event) add('block', 'conflict_same_event', `${c.fight_name} already has an active bout at this event.`, s);
    if ((c.active_bouts_elsewhere ?? 0) > 0)
      add('info', 'active_elsewhere', `${c.fight_name} has ${c.active_bouts_elsewhere} active bout(s) at other events — check dates.`, s);
  });
  if (a.gym_id && a.gym_id === b.gym_id) add('review', 'same_gym', `Both fighters train at ${a.gym_name ?? 'the same gym'}.`);

  // ---- 3. Weight --------------------------------------------------------------------------
  let weightScore: ComponentScore = { score: null, detail: 'Weight missing' };
  let proposed: Evaluation['proposed_weight_class'] = null;
  let diff: number | null = null;
  both((c, s) => {
    if (c.weight_g == null) {
      missing.push(`${c.fight_name}: current weight`);
      add('review', 'weight_missing', `${c.fight_name} has no recorded weight.`, s);
      return;
    }
    const days = weightAgeDays(c.weight_recorded_at ?? null, now);
    if (days == null || days > rules.weight_stale_after_days)
      add('review', 'weight_stale', `${c.fight_name}'s weight is ${days == null ? 'undated' : `${days} days old`}.`, s);
  });
  if (a.weight_g != null && b.weight_g != null) {
    diff = Math.abs(a.weight_g - b.weight_g);
    const heavier = Math.max(a.weight_g, b.weight_g);
    const wc = classifyWeight(heavier, classes, a.division);
    const limit = Math.min(rules.max_weight_diff_g, wc?.allowed_diff_g ?? rules.max_weight_diff_g);
    if (wc) proposed = { id: wc.id, name: wc.name };
    else if (classes.length) add('review', 'no_weight_class', 'No configured weight class fits the heavier fighter.');
    if (diff > limit) {
      add('block', 'weight_gap', `Weight difference ${(diff / 1000).toFixed(1)} kg exceeds the permitted ${(limit / 1000).toFixed(1)} kg.`);
    }
    weightScore = { score: clamp01(1 - diff / Math.max(limit, 1)), detail: `${(diff / 1000).toFixed(1)} kg apart (limit ${(limit / 1000).toFixed(1)} kg)` };
    explanation.push(`Weights ${weightScore.detail}${proposed ? `, proposed ${proposed.name}` : ''}.`);
  }

  // ---- 5–6. Experience & record ------------------------------------------------------------
  const tA = totalFights(a.record);
  const tB = totalFights(b.record);
  let expScore: ComponentScore = { score: null, detail: 'Fight record missing' };
  let recScore: ComponentScore = { score: null, detail: 'Fight record missing' };
  both((c, s) => {
    if (!c.record) {
      missing.push(`${c.fight_name}: fight record`);
      add('review', 'record_missing', `${c.fight_name} has no fight record.`, s);
    } else if (c.record.kind !== 'verified') {
      add(rules.require_verified_record ? 'review' : 'info', 'record_unverified', `${c.fight_name}'s record is self-reported.`, s);
    }
  });
  if (tA != null && tB != null) {
    const gap = Math.abs(tA - tB);
    if (gap > rules.max_experience_gap_hard) add('block', 'experience_gap', `Experience gap of ${gap} fights exceeds the limit of ${rules.max_experience_gap_hard}.`);
    else if (gap > rules.max_experience_gap_soft) add('review', 'experience_gap_soft', `Experience gap of ${gap} fights.`);
    expScore = { score: clamp01(1 - gap / Math.max(rules.max_experience_gap_hard, 1)), detail: `${tA} vs ${tB} fights` };
    explanation.push(`Experience ${expScore.detail}.`);
    const [rA, rB] = [winRate(a.record), winRate(b.record)];
    const sim = rA == null && rB == null ? 1 : 1 - Math.abs((rA ?? 0.5) - (rB ?? 0.5));
    recScore = {
      score: clamp01(sim),
      detail: `${fmtRecord(a.record!)} vs ${fmtRecord(b.record!)}`,
    };
    explanation.push(`Records ${recScore.detail}.`);
  }

  // ---- Age & skill components ------------------------------------------------------------
  let ageScore: ComponentScore = { score: null, detail: 'Age unknown' };
  if (ages[0] != null && ages[1] != null) {
    const g = Math.abs(ages[0] - ages[1]);
    ageScore = { score: clamp01(1 - g / (rules.max_age_gap_years_soft * 2)), detail: `${ages[0]} vs ${ages[1]} years` };
    if (g > rules.max_age_gap_years_soft) add('review', 'age_gap', `Age gap of ${g} years.`);
  }
  let skillScore: ComponentScore = { score: null, detail: 'Skill level not provided' };
  if (a.skill_level && b.skill_level) {
    const g = Math.abs(SKILL[a.skill_level] - SKILL[b.skill_level]);
    skillScore = { score: 1 - g / 3, detail: `${a.skill_level} vs ${b.skill_level}` };
    if (g >= 2) add('review', 'skill_gap', `Skill levels differ substantially (${skillScore.detail}).`);
  }
  if (a.primary_style && b.primary_style) explanation.push(`Styles: ${a.primary_style} vs ${b.primary_style}.`);

  const components = { weight: weightScore, experience: expScore, record: recScore, age: ageScore, skill: skillScore };

  // ---- Score: weighted mean over the components that could be computed ---------------------
  let num = 0;
  let den = 0;
  for (const [k, w] of Object.entries(rules.weights) as [keyof typeof components, number][]) {
    const s = components[k].score;
    if (s != null && w > 0) {
      num += s * w;
      den += w;
    }
  }
  // Never score on weight alone: require weight AND experience to be known.
  const score = den > 0 && weightScore.score != null && expScore.score != null ? Math.round((num / den) * 1000) / 10 : null;

  const hasBlock = issues.some((i) => i.severity === 'block');
  const hasReview = issues.some((i) => i.severity === 'review');
  let classification: Classification;
  if (hasBlock) classification = 'ineligible';
  else if (hasReview || score == null) classification = 'requires_review';
  else if (score >= rules.strong_threshold) classification = 'strong_candidate';
  else if (score >= rules.possible_threshold) classification = 'possible_candidate';
  else classification = 'requires_review';

  if (score == null) explanation.push('Not enough verified information to score this pairing.');

  return {
    fighter_a_id: a.fighter_id,
    fighter_b_id: b.fighter_id,
    score,
    classification,
    proposed_weight_class: proposed,
    weight_diff_g: diff,
    components,
    explanation,
    missing,
    issues,
  };
}

function fmtRecord(r: FighterRecord) {
  return `${r.wins}-${r.losses}-${r.draws}${r.no_contests ? ` (${r.no_contests} NC)` : ''}${r.kind === 'verified' ? '' : '*'}`;
}

const ORDER: Record<Classification, number> = { strong_candidate: 0, possible_candidate: 1, requires_review: 2, ineligible: 3 };

/** Evaluate every pair. Ineligible pairs are dropped unless requested. Sorted best first. */
export function generateSuggestions(
  candidates: readonly Candidate[],
  ctx: EventContext,
  rules: Partial<MatchRules> | null | undefined,
  classes: readonly WeightClassLimits[],
  opts: { includeIneligible?: boolean; limit?: number; now?: Date } = {},
): Evaluation[] {
  const out: Evaluation[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const e = evaluatePair(candidates[i], candidates[j], ctx, rules, classes, opts.now);
      if (opts.includeIneligible || e.classification !== 'ineligible') out.push(e);
    }
  }
  out.sort((x, y) => ORDER[x.classification] - ORDER[y.classification] || (y.score ?? -1) - (x.score ?? -1));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  strong_candidate: 'Strong candidate',
  possible_candidate: 'Possible candidate',
  requires_review: 'Requires review',
  ineligible: 'Ineligible',
};
