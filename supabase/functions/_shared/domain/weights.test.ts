import { describe, expect, it } from 'vitest';
import { GRAMS_PER_LB, classifyWeight, formatWeight, gramsToLb, inWeightClass, toGrams, weightAgeDays } from './weights';

const lb = (n: number) => Math.round(n * GRAMS_PER_LB);
const classes = [
  { id: 'fly', name: 'Flyweight', division: 'men', min_g: null, max_g: lb(125), allowed_diff_g: lb(4) },
  { id: 'ban', name: 'Bantamweight', division: 'men', min_g: lb(125), max_g: lb(135), allowed_diff_g: lb(4) },
  { id: 'lw', name: 'Lightweight', division: 'men', min_g: lb(145), max_g: lb(155), allowed_diff_g: lb(5) },
  { id: 'wstraw', name: 'Strawweight', division: 'women', min_g: null, max_g: lb(115), allowed_diff_g: lb(4) },
];

describe('weight conversion', () => {
  it('uses the exact international pound', () => {
    expect(toGrams(1, 'lb')).toBe(454);
    expect(toGrams(155, 'lb')).toBe(70307);
    expect(toGrams(70.3, 'kg')).toBe(70300);
    expect(gramsToLb(toGrams(155, 'lb'))).toBeCloseTo(155, 2);
  });
  it('rejects nonsense input', () => {
    expect(() => toGrams(0, 'kg')).toThrow();
    expect(() => toGrams(-5, 'lb')).toThrow();
    expect(() => toGrams(Number.NaN, 'kg')).toThrow();
  });
  it('formats both units and says when missing', () => {
    expect(formatWeight(70307)).toBe('70.3 kg (155.0 lb)');
    expect(formatWeight(70307, 'lb')).toBe('155.0 lb (70.3 kg)');
    expect(formatWeight(null)).toBe('Not provided');
  });
});

describe('class boundaries', () => {
  it('upper bound inclusive, lower bound exclusive', () => {
    expect(inWeightClass(lb(135), classes[1])).toBe(true);
    expect(inWeightClass(lb(125), classes[1])).toBe(false);
    expect(inWeightClass(lb(125) + 1, classes[1])).toBe(true);
    expect(inWeightClass(lb(135) + 1, classes[1])).toBe(false);
  });
  it('classifies into the lightest eligible class for the division', () => {
    expect(classifyWeight(lb(125), classes, 'men')?.id).toBe('fly');
    expect(classifyWeight(lb(130), classes, 'men')?.id).toBe('ban');
    expect(classifyWeight(lb(110), classes, 'women')?.id).toBe('wstraw');
    expect(classifyWeight(lb(140), classes, 'men')).toBeNull(); // gap: no featherweight configured
    expect(classifyWeight(lb(300), classes, 'men')).toBeNull();
  });
});

describe('weight freshness', () => {
  it('counts whole days and handles missing dates', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(weightAgeDays('2026-10-20T12:00:00Z', now)).toBe(6);
    expect(weightAgeDays(null, now)).toBeNull();
    expect(weightAgeDays('not a date', now)).toBeNull();
  });
});
