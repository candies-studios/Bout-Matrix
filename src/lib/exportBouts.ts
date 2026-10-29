// Bout list export (Excel / PDF) with selectable columns. The heavy libraries are loaded only when exporting.
import { humanize } from './format';

export interface ExportFighter {
  name: string; legal_name: string | null; fighter_code: string; gym: string | null; city: string | null; country: string | null;
  record: string | null; record_verified: boolean; weight_g: number | null; age: number | null; date_of_birth: string | null;
  phone: string | null; email: string | null; coach: string | null; division: string | null;
}
export interface ExportBout {
  bout_code: string; status: string; card_order: number | null; card_segment: string; is_published: boolean;
  weight_class: string | null; weight_limit_g: number | null; contracted_weight_g: number | null;
  rounds: number; round_minutes: number; division: string | null; event_name: string;
  red: ExportFighter; blue: ExportFighter;
}

type Cell = string | number | null;
export interface ColumnDef { key: string; label: string; width: number; value: (b: ExportBout) => Cell }
export interface FighterColumnDef { key: string; label: string; width: number; value: (f: ExportFighter) => Cell }

const kg = (g: number | null) => (g == null ? null : Math.round(g / 100) / 10);
const SEGMENT: Record<string, string> = { main_card: 'Main card', prelims: 'Prelims', early_prelims: 'Early prelims' };

/** Position on the card: main event and co-main event are the first two main-card bouts. */
export function billing(b: ExportBout): string {
  if (b.card_segment === 'main_card' && b.card_order === 1) return 'Main event';
  if (b.card_segment === 'main_card' && b.card_order === 2) return 'Co-main event';
  return SEGMENT[b.card_segment] ?? humanize(b.card_segment);
}

export const BOUT_COLUMNS: ColumnDef[] = [
  { key: 'order', label: 'Bout #', width: 7, value: (b) => b.card_order },
  { key: 'billing', label: 'Card position', width: 14, value: billing },
  { key: 'bout_code', label: 'Bout ID', width: 12, value: (b) => b.bout_code },
  { key: 'weight_class', label: 'Weight class', width: 18, value: (b) => b.weight_class ?? 'Catchweight' },
  { key: 'limit', label: 'Limit (kg)', width: 9, value: (b) => kg(b.contracted_weight_g ?? b.weight_limit_g) },
  { key: 'division', label: 'Division', width: 22, value: (b) => (b.division ? humanize(b.division) : null) },
  { key: 'format', label: 'Rounds', width: 10, value: (b) => `${b.rounds} x ${b.round_minutes} min` },
  { key: 'status', label: 'Status', width: 12, value: (b) => humanize(b.status) },
  { key: 'published', label: 'On public card', width: 10, value: (b) => (b.is_published ? 'Yes' : 'No') },
];

export const FIGHTER_COLUMNS: FighterColumnDef[] = [
  { key: 'name', label: 'Name', width: 22, value: (f) => f.name },
  { key: 'legal_name', label: 'Legal name', width: 22, value: (f) => f.legal_name },
  { key: 'fighter_code', label: 'Fighter ID', width: 12, value: (f) => f.fighter_code },
  { key: 'gym', label: 'Club / gym', width: 22, value: (f) => f.gym },
  { key: 'record', label: 'Record', width: 9, value: (f) => (f.record ? `${f.record}${f.record_verified ? '' : '*'}` : null) },
  { key: 'weight', label: 'Weight (kg)', width: 9, value: (f) => kg(f.weight_g) },
  { key: 'age', label: 'Age', width: 6, value: (f) => f.age },
  { key: 'dob', label: 'Date of birth', width: 12, value: (f) => f.date_of_birth },
  { key: 'city', label: 'City', width: 14, value: (f) => f.city },
  { key: 'phone', label: 'Phone', width: 16, value: (f) => f.phone },
  { key: 'email', label: 'Email', width: 24, value: (f) => f.email },
  { key: 'coach', label: 'Coach', width: 18, value: (f) => f.coach },
];

export const DEFAULT_BOUT_COLUMNS = ['order', 'billing', 'weight_class', 'division', 'format'];
export const DEFAULT_FIGHTER_COLUMNS = ['name', 'fighter_code', 'gym', 'record', 'weight'];

export interface ExportTable { headers: string[]; widths: number[]; rows: Cell[][] }

/** Builds the table: chosen bout columns, then the chosen fighter columns for the red corner, then the blue corner. */
export function buildTable(bouts: ExportBout[], boutKeys: string[], fighterKeys: string[]): ExportTable {
  const bc = BOUT_COLUMNS.filter((c) => boutKeys.includes(c.key));
  const fc = FIGHTER_COLUMNS.filter((c) => fighterKeys.includes(c.key));
  const headers = [...bc.map((c) => c.label), ...fc.map((c) => `Red: ${c.label}`), ...fc.map((c) => `Blue: ${c.label}`)];
  const widths = [...bc.map((c) => c.width), ...fc.map((c) => c.width), ...fc.map((c) => c.width)];
  const rows = bouts.map((b) => [...bc.map((c) => c.value(b)), ...fc.map((c) => c.value(b.red)), ...fc.map((c) => c.value(b.blue))]);
  return { headers, widths, rows };
}

export function exportFileName(eventName: string, ext: 'xlsx' | 'pdf') {
  const slug = eventName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
  return `${slug}-bouts-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function downloadExcel(t: ExportTable, eventName: string, subtitle: string) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const data = [
    [{ value: `${eventName} — bout list`, fontWeight: 'bold' as const }],
    [{ value: subtitle }],
    [],
    t.headers.map((h) => ({ value: h, fontWeight: 'bold' as const, backgroundColor: '#E5E7EB' })),
    ...t.rows.map((r) => r.map((v) => (v == null ? null : typeof v === 'number' ? { value: v, type: Number } : { value: String(v) }))),
  ];
  const blob = await writeXlsxFile(data as never, {
    sheet: 'Bouts',
    columns: t.widths.map((width) => ({ width })),
    stickyRowsCount: 4,
  }).toBlob();
  download(blob, exportFileName(eventName, 'xlsx'));
}

export async function downloadPdf(t: ExportTable, eventName: string, subtitle: string) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const wide = t.headers.length > 8;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: wide ? 'a3' : 'a4' });
  doc.setFontSize(16);
  doc.text(`${eventName} — bout list`, 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(subtitle, 40, 56);
  autoTable(doc, {
    startY: 70,
    head: [t.headers],
    body: t.rows.map((r) => r.map((v) => (v == null ? '' : String(v)))),
    styles: { fontSize: wide ? 7 : 8, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [185, 28, 28], textColor: 255 },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    margin: { left: 40, right: 40 },
    didDrawPage: () => {
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(`Page ${doc.getNumberOfPages()}`, doc.internal.pageSize.getWidth() - 80, doc.internal.pageSize.getHeight() - 20);
    },
  });
  download(doc.output('blob'), exportFileName(eventName, 'pdf'));
}
