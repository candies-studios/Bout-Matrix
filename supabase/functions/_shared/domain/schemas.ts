// Registration schemas shared by the browser forms and the Edge Functions (which re-validate).
import { z } from 'zod';

export const CONSENT_VERSION = 'v1';
export const DIVISIONS = ['men', 'women'] as const;
export const COMPETITION_LEVELS = ['amateur', 'semi_pro', 'professional'] as const;
export const SKILL_LEVELS = ['novice', 'intermediate', 'advanced', 'elite'] as const;

const trimmed = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} is required.`).max(max, `${label} must be at most ${max} characters.`);
const optionalText = (max: number) =>
  z.string().trim().max(max, `Must be at most ${max} characters.`).optional().or(z.literal('').transform(() => undefined));
const count = (label: string) =>
  z.coerce.number({ error: `${label} must be a number.` }).int(`${label} must be a whole number.`).min(0, `${label} cannot be negative.`).max(500);
const optionalCount = (label: string) =>
  z.union([z.literal('').transform(() => undefined), count(label)]).optional();
const optionalNumber = (min: number, max: number, label: string) =>
  z
    .union([z.literal('').transform(() => undefined), z.coerce.number({ error: `${label} must be a number.` }).min(min, `${label} looks too small.`).max(max, `${label} looks too large.`)])
    .optional();

export const phoneCountryCode = z.string().trim().regex(/^\+[0-9]{1,4}$/, 'Use the format +91.');
export const phone = z.string().trim().regex(/^[0-9 ()-]{5,20}$/, 'Enter digits only (5–20).');

export function ageOnDate(dob: string, on = new Date()): number {
  const d = new Date(dob + 'T00:00:00Z');
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const m = on.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export const DocumentRef = z.object({
  kind: z.string().regex(/^[a-z_]{2,40}$/),
  path: z.string().regex(/^pending\/[0-9a-f-]{36}\/[a-z_]{2,40}\.(jpg|png|webp|pdf)$/),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  size_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
});

export const FighterRegistrationSchema = z
  .object({
    submission_key: z.uuid(),
    event_slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80).optional().nullable(),
    existing_fighter_code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,8}-F-\d{4,}$/, 'Fighter IDs look like WDS-F-0001.')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    legal_name: trimmed(2, 120, 'Full legal name'),
    fight_name: trimmed(2, 80, 'Fight name'),
    nickname: optionalText(60),
    date_of_birth: z.iso.date('Enter a valid date of birth.').refine((d) => {
      const a = ageOnDate(d);
      return a >= 14 && a <= 70;
    }, 'Date of birth looks incorrect.'),
    email: z.email('Enter a valid email address.').transform((s) => s.toLowerCase()),
    phone_country_code: phoneCountryCode,
    phone,
    city: trimmed(2, 80, 'City'),
    country: trimmed(2, 80, 'Country'),
    division: z.enum(DIVISIONS, { error: 'Choose a division.' }),
    competition_level: z.enum(COMPETITION_LEVELS, { error: 'Choose your competition level.' }),
    gym_id: z.uuid().optional().or(z.literal('').transform(() => undefined)),
    gym_name: optionalText(120),
    coach_name: optionalText(120),
    mma_experience_years: optionalNumber(0, 60, 'Years of experience'),
    wins: count('Wins'),
    losses: count('Losses'),
    draws: count('Draws'),
    no_contests: count('No contests'),
    ko_tko_wins: optionalCount('KO/TKO wins'),
    submission_wins: optionalCount('Submission wins'),
    decision_wins: optionalCount('Decision wins'),
    primary_style: optionalText(60),
    skill_level: z.enum(SKILL_LEVELS).optional().or(z.literal('').transform(() => undefined)),
    weight_value: z.coerce.number({ error: 'Enter your current weight.' }).positive('Enter your current weight.'),
    weight_unit: z.enum(['kg', 'lb']),
    preferred_weight_class_id: z.uuid().optional().or(z.literal('').transform(() => undefined)),
    height_cm: optionalNumber(120, 230, 'Height'),
    reach_cm: optionalNumber(110, 250, 'Reach'),
    previous_experience: optionalText(2000),
    is_available: z.boolean().default(true),
    availability_notes: optionalText(500),
    photo_path: z
      .string()
      .regex(/^pending\/[0-9a-f-]{36}\/profile_photo\.(jpg|png|webp)$/)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    documents: z.array(DocumentRef).max(5).default([]),
    consent_data: z.literal(true, { error: 'You must agree to the data-processing statement.' }),
    consent_rules: z.literal(true, { error: 'You must confirm the declaration.' }),
    website: z.string().max(0).optional(), // honeypot: must stay empty
  })
  .superRefine((v, ctx) => {
    const kg = v.weight_unit === 'kg' ? v.weight_value : v.weight_value * 0.45359237;
    if (kg < 35 || kg > 180) ctx.addIssue({ code: 'custom', path: ['weight_value'], message: 'Weight must be between 35 and 180 kg (77–397 lb).' });
    const methods = (v.ko_tko_wins ?? 0) + (v.submission_wins ?? 0) + (v.decision_wins ?? 0);
    if (methods > v.wins) ctx.addIssue({ code: 'custom', path: ['ko_tko_wins'], message: 'KO, submission and decision wins cannot exceed total wins.' });
    if (!v.gym_id && !v.gym_name) ctx.addIssue({ code: 'custom', path: ['gym_name'], message: 'Enter your gym or academy (or "Independent").' });
  });

export type FighterRegistrationInput = z.input<typeof FighterRegistrationSchema>;
export type FighterRegistration = z.output<typeof FighterRegistrationSchema>;

export const CoachRegistrationSchema = z
  .object({
    submission_key: z.uuid(),
    event_slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80).optional().nullable(),
    full_name: trimmed(2, 120, 'Full name'),
    email: z.email('Enter a valid email address.').transform((s) => s.toLowerCase()),
    phone_country_code: phoneCountryCode,
    phone,
    gym_id: z.uuid().optional().or(z.literal('').transform(() => undefined)),
    gym_name: optionalText(120),
    city: trimmed(2, 80, 'City'),
    country: trimmed(2, 80, 'Country'),
    coaching_experience_years: z.coerce.number().int().min(0).max(80),
    experience_summary: optionalText(2000),
    verification_info: optionalText(1000),
    roster: z.array(z.string().trim().min(2).max(80)).max(100).default([]),
    consent_data: z.literal(true, { error: 'You must agree to the data-processing statement.' }),
    website: z.string().max(0).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.gym_id && !v.gym_name) ctx.addIssue({ code: 'custom', path: ['gym_name'], message: 'Enter your gym or academy.' });
  });

export type CoachRegistrationInput = z.input<typeof CoachRegistrationSchema>;
export type CoachRegistration = z.output<typeof CoachRegistrationSchema>;

/** Flatten Zod issues into { field: message } for forms. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of error.issues) {
    const k = String(i.path[0] ?? '_form');
    if (!out[k]) out[k] = i.message;
  }
  return out;
}
