// Bout lifecycle. MUST stay identical to public.bout_status_transitions (enforced by tests/db/bouts.test.ts).
// The database is the authority; this copy exists so the UI can show only legal actions.

export const BOUT_STATUSES = [
  'draft',
  'offer_sent',
  'awaiting_responses',
  'accepted_one',
  'accepted_both',
  'declined',
  'expired',
  'under_review',
  'confirmed',
  'cancelled',
  'completed',
] as const;

export type BoutStatus = (typeof BOUT_STATUSES)[number];

export const BOUT_TRANSITIONS: Readonly<Record<BoutStatus, readonly BoutStatus[]>> = {
  draft: ['offer_sent', 'cancelled'],
  offer_sent: ['awaiting_responses', 'accepted_one', 'declined', 'expired', 'under_review', 'cancelled'],
  awaiting_responses: ['accepted_one', 'declined', 'expired', 'under_review', 'cancelled'],
  accepted_one: ['accepted_both', 'declined', 'expired', 'under_review', 'cancelled'],
  accepted_both: ['confirmed', 'under_review', 'cancelled'],
  declined: ['under_review', 'cancelled'],
  expired: ['under_review', 'offer_sent', 'cancelled'],
  under_review: ['draft', 'offer_sent', 'confirmed', 'cancelled'],
  confirmed: ['completed', 'under_review', 'cancelled'],
  cancelled: [],
  completed: [],
};

/** Statuses an administrator may request directly (the rest are driven by the offer workflow). */
export const MANUAL_TARGETS: readonly BoutStatus[] = ['draft', 'under_review', 'confirmed', 'cancelled', 'completed'];

/** Targets that require event-administrator (not just matchmaker) rights. */
export const ADMIN_ONLY_TARGETS: readonly BoutStatus[] = ['confirmed', 'cancelled', 'completed'];

/** Targets that require a written reason. */
export const REASON_REQUIRED: readonly BoutStatus[] = ['under_review', 'cancelled'];

export function canTransition(from: BoutStatus, to: BoutStatus): boolean {
  return BOUT_TRANSITIONS[from].includes(to);
}

/** Active bouts hold their fighters; a fighter may have only one active bout per event. */
export function isActiveBout(status: BoutStatus): boolean {
  return !['declined', 'expired', 'cancelled', 'completed'].includes(status);
}

export function isPublishable(status: BoutStatus): boolean {
  return status === 'confirmed' || status === 'completed';
}

/** Terms (opponent, weight, rounds, rules) may only be edited in these states. */
export function termsEditable(status: BoutStatus): boolean {
  return status === 'draft' || status === 'under_review';
}

export const BOUT_STATUS_LABELS: Record<BoutStatus, string> = {
  draft: 'Draft',
  offer_sent: 'Offer sent',
  awaiting_responses: 'Awaiting responses',
  accepted_one: 'Accepted by one fighter',
  accepted_both: 'Accepted by both fighters',
  declined: 'Declined',
  expired: 'Expired',
  under_review: 'Under administrative review',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

/** Manual actions available to a user, given the current status and their rights. */
export function availableManualActions(status: BoutStatus, isEventAdmin: boolean): BoutStatus[] {
  return BOUT_TRANSITIONS[status].filter(
    (to) => MANUAL_TARGETS.includes(to) && (isEventAdmin || !ADMIN_ONLY_TARGETS.includes(to)),
  );
}
