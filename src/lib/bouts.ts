import type { BoutStatus } from '@domain/boutStatus.ts';
import type { Evaluation } from '@domain/matchmaking.ts';
import type { Access } from './access';

export const BOUT_SELECT = `id, bout_code, event_id, status, offer_version, offer_expires_at, rounds, round_minutes, contracted_weight_g, rules_text,
  proposed_starts_at, card_order, card_segment, is_published, confirmed_at, admin_notes, override_reason, cancel_reason, evaluation, updated_at, replaces_bout_id,
  fighter_a_id, fighter_b_id, weight_class_id,
  fighter_a:fighters!bouts_fighter_a_id_fkey(fight_name, fighter_code), fighter_b:fighters!bouts_fighter_b_id_fkey(fight_name, fighter_code),
  weight_classes(name)`;

export interface BoutRow {
  id: string; bout_code: string; event_id: string; status: BoutStatus; offer_version: number; offer_expires_at: string | null; rounds: number; round_minutes: number;
  contracted_weight_g: number | null; rules_text: string | null; proposed_starts_at: string | null; card_order: number | null; card_segment: string | null;
  is_published: boolean; confirmed_at: string | null; admin_notes: string | null; override_reason: string | null; cancel_reason: string | null;
  evaluation: Evaluation | null; updated_at: string; replaces_bout_id: string | null; fighter_a_id: string; fighter_b_id: string; weight_class_id: string | null;
  fighter_a: { fight_name: string; fighter_code: string } | null; fighter_b: { fight_name: string; fighter_code: string } | null; weight_classes: { name: string } | null;
}

export function canManageEvent(a: Access | null, eventId: string) {
  return !!a && (a.is_super_admin || a.org_roles.some((r) => r.role === 'org_admin') || a.event_roles.some((r) => r.event_id === eventId && r.role === 'event_admin'));
}

