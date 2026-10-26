export const EVENT_STATUSES = ['draft', 'registration_open', 'registration_closed', 'matchmaking', 'fight_card_pending', 'published', 'completed', 'cancelled'] as const;

export function slugify(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
