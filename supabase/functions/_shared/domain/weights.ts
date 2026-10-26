// Canonical weight unit: integer grams. Exact international pound definition.
export const GRAMS_PER_LB = 453.59237;
export const GRAMS_PER_KG = 1000;

export type WeightUnit = 'kg' | 'lb';

export function toGrams(value: number, unit: WeightUnit): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('weight must be a positive number');
  return Math.round(unit === 'kg' ? value * GRAMS_PER_KG : value * GRAMS_PER_LB);
}

export function gramsToKg(g: number): number {
  return g / GRAMS_PER_KG;
}

export function gramsToLb(g: number): number {
  return g / GRAMS_PER_LB;
}

/** Display both units, e.g. "70.3 kg (155.0 lb)". */
export function formatWeight(g: number | null | undefined, primary: WeightUnit = 'kg'): string {
  if (g == null) return 'Not provided';
  const kg = `${gramsToKg(g).toFixed(1)} kg`;
  const lb = `${gramsToLb(g).toFixed(1)} lb`;
  return primary === 'kg' ? `${kg} (${lb})` : `${lb} (${kg})`;
}

export interface WeightClassLimits {
  id: string;
  name: string;
  division: string | null;
  /** Exclusive lower bound in grams (null = no lower bound). */
  min_g: number | null;
  /** Inclusive upper bound in grams. */
  max_g: number;
  /** Maximum permitted difference between opponents in this class. */
  allowed_diff_g: number;
}

/** Does `g` fall inside the class? Lower bound exclusive, upper bound inclusive. */
export function inWeightClass(g: number, wc: Pick<WeightClassLimits, 'min_g' | 'max_g'>): boolean {
  return (wc.min_g == null || g > wc.min_g) && g <= wc.max_g;
}

/** The lightest class (for the division) whose limit the weight does not exceed. */
export function classifyWeight<T extends WeightClassLimits>(
  g: number,
  classes: readonly T[],
  division: string | null,
): T | null {
  const candidates = classes
    .filter((wc) => wc.division == null || division == null || wc.division === division)
    .filter((wc) => inWeightClass(g, wc))
    .sort((a, b) => a.max_g - b.max_g);
  return candidates[0] ?? null;
}

/** Days since a weight was recorded; null if unknown. */
export function weightAgeDays(recordedAt: string | Date | null | undefined, now: Date = new Date()): number | null {
  if (!recordedAt) return null;
  const t = typeof recordedAt === 'string' ? Date.parse(recordedAt) : recordedAt.getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}
