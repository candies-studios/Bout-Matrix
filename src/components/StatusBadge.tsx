import { BOUT_STATUS_LABELS, type BoutStatus } from '@domain/boutStatus';
import { Badge, type Tone } from './ui';

const boutTone: Record<BoutStatus, Tone> = {
  draft: 'neutral',
  offer_sent: 'info',
  awaiting_responses: 'info',
  accepted_one: 'info',
  accepted_both: 'warn',
  declined: 'danger',
  expired: 'danger',
  under_review: 'warn',
  confirmed: 'ok',
  cancelled: 'neutral',
  completed: 'neutral',
};

export function BoutStatusBadge({ status }: { status: BoutStatus }) {
  return <Badge tone={boutTone[status]}>{BOUT_STATUS_LABELS[status]}</Badge>;
}

export type RegistrationStatus = 'draft' | 'submitted' | 'under_review' | 'approved' | 'rejected' | 'incomplete';
const regTone: Record<RegistrationStatus, Tone> = {
  draft: 'neutral',
  submitted: 'info',
  under_review: 'warn',
  approved: 'ok',
  rejected: 'danger',
  incomplete: 'warn',
};
const regLabel: Record<RegistrationStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Rejected',
  incomplete: 'Incomplete',
};
export function RegistrationStatusBadge({ status }: { status: RegistrationStatus }) {
  return <Badge tone={regTone[status]}>{regLabel[status]}</Badge>;
}
