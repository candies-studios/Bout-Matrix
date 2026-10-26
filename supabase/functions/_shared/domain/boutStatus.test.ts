import { describe, expect, it } from 'vitest';
import { BOUT_STATUSES, BOUT_TRANSITIONS, availableManualActions, canTransition, isActiveBout, isPublishable, termsEditable } from './boutStatus';

describe('bout status graph', () => {
  it('terminal states have no exits and every target is a known status', () => {
    expect(BOUT_TRANSITIONS.cancelled).toEqual([]);
    expect(BOUT_TRANSITIONS.completed).toEqual([]);
    for (const s of BOUT_STATUSES) for (const t of BOUT_TRANSITIONS[s]) expect(BOUT_STATUSES).toContain(t);
  });
  it('confirmation is only reachable after both accept or via review', () => {
    const into = BOUT_STATUSES.filter((s) => canTransition(s, 'confirmed'));
    expect(into.sort()).toEqual(['accepted_both', 'under_review']);
  });
  it('declines and expiries always pass through admin review before re-offer', () => {
    expect(canTransition('declined', 'offer_sent')).toBe(false);
    expect(canTransition('declined', 'under_review')).toBe(true);
  });
  it('helper predicates', () => {
    expect(isActiveBout('confirmed')).toBe(true);
    expect(isActiveBout('declined')).toBe(false);
    expect(isPublishable('accepted_both')).toBe(false);
    expect(termsEditable('offer_sent')).toBe(false);
  });
  it('matchmakers do not get admin-only actions', () => {
    expect(availableManualActions('accepted_both', false)).toEqual(['under_review']);
    expect(availableManualActions('accepted_both', true)).toEqual(['confirmed', 'under_review', 'cancelled']);
  });
});
