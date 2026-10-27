export { formatWeight } from '@domain/weights.ts';

export const TBA = 'To Be Announced';

export function formatDateTime(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return TBA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return TBA;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timeZone || undefined }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return TBA;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? TBA : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function venueText(e: { venue_name?: string | null; venue_city?: string | null; venue_country?: string | null }): string {
  if (!e.venue_name) return e.venue_city ? `${TBA} · ${e.venue_city}` : TBA;
  return [e.venue_name, e.venue_city, e.venue_country].filter(Boolean).join(', ');
}

export interface RecordLike {
  wins: number;
  losses: number;
  draws: number;
  no_contests?: number | null;
}
export function recordText(r: RecordLike | null | undefined): string {
  if (!r) return '—';
  return `${r.wins}-${r.losses}-${r.draws}${r.no_contests ? ` (${r.no_contests} NC)` : ''}`;
}

export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

// Division slugs can only contain letters and underscores, so "K1" / "U18" are spelled out in them.
const DIVISION_WORDS: [RegExp, string][] = [
  [/\bk one\b/g, 'K1'], [/\bmma tourney\b/g, 'MMA tournament'], [/\bmma\b/g, 'MMA'],
  [/\bu eighteen\b/g, 'U18'], [/\bu sixteen\b/g, 'U16'], [/\bu fourteen\b/g, 'U14'], [/\bu twelve\b/g, 'U12'],
];

export function humanize(s: string): string {
  let out = s.replace(/_/g, ' ');
  for (const [re, word] of DIVISION_WORDS) out = out.replace(re, word);
  return out.replace(/^\w/, (c) => c.toUpperCase());
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

export function downloadText(filename: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
