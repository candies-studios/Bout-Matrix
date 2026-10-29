import { afterEach, describe, expect, it, vi } from 'vitest';
import { billing, buildTable, DEFAULT_BOUT_COLUMNS, DEFAULT_FIGHTER_COLUMNS, downloadExcel, downloadPdf, type ExportBout } from './exportBouts';

const f = (name: string, code: string) => ({
  name, legal_name: `${name} Legal`, fighter_code: code, gym: 'Fit and Fight Club', city: 'Mumbai', country: 'India', record: '3-1-0',
  record_verified: false, weight_g: 61200, age: 22, date_of_birth: '2004-03-10', phone: '+91 9876543210', email: null, coach: 'Coach X', division: 'mma_adult_men',
});
const bout = (i: number, seg: string): ExportBout => ({
  bout_code: `WDS-B-000${i}`, status: 'confirmed', card_order: i, card_segment: seg, is_published: i < 3, weight_class: 'Bantamweight',
  weight_limit_g: 61200, contracted_weight_g: null, rounds: 3, round_minutes: 3, division: 'mma_adult_men', event_name: 'WDS Rising Star 8',
  red: f(`Red Fighter ${i}`, `WDS-F-00${10 + i}`), blue: f(`Blue Fighter ${i}`, `WDS-F-00${20 + i}`),
});
const bouts = [bout(1, 'main_card'), bout(2, 'main_card'), bout(3, 'main_card'), bout(4, 'prelims'), bout(5, 'early_prelims')];

afterEach(() => vi.restoreAllMocks());

describe('bout export', () => {
  it('labels main event / co-main event and builds the chosen columns for both corners', () => {
    expect(bouts.map(billing)).toEqual(['Main event', 'Co-main event', 'Main card', 'Prelims', 'Early prelims']);
    const t = buildTable(bouts, DEFAULT_BOUT_COLUMNS, DEFAULT_FIGHTER_COLUMNS);
    expect(t.headers).toEqual(['Bout #', 'Card position', 'Weight class', 'Division', 'Rounds',
      'Red: Name', 'Red: Fighter ID', 'Red: Club / gym', 'Red: Record', 'Red: Weight (kg)',
      'Blue: Name', 'Blue: Fighter ID', 'Blue: Club / gym', 'Blue: Record', 'Blue: Weight (kg)']);
    expect(t.rows[0]).toEqual([1, 'Main event', 'Bantamweight', 'MMA adult men', '3 x 3 min', 'Red Fighter 1', 'WDS-F-0011', 'Fit and Fight Club', '3-1-0*', 61.2,
      'Blue Fighter 1', 'WDS-F-0021', 'Fit and Fight Club', '3-1-0*', 61.2]);
    expect(buildTable(bouts, ['bout_code'], []).headers).toEqual(['Bout ID']);
  });

  it('produces a real .xlsx and .pdf file', async () => {
    const files: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { files.push(b as Blob); return 'blob:x'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const t = buildTable(bouts, DEFAULT_BOUT_COLUMNS, [...DEFAULT_FIGHTER_COLUMNS, 'phone', 'coach']);
    await downloadExcel(t, 'WDS Rising Star 8', 'Confirmed bouts · 5 bouts');
    await downloadPdf(t, 'WDS Rising Star 8', 'Confirmed bouts · 5 bouts');
    const [xlsx, pdf] = await Promise.all(files.map(async (b) => new Uint8Array(await b.arrayBuffer())));
    expect(String.fromCharCode(xlsx[0], xlsx[1])).toBe('PK');           // zip container = xlsx
    expect(String.fromCharCode(...pdf.slice(0, 4))).toBe('%PDF');
    if (process.env.EXPORT_SAMPLE_DIR) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${process.env.EXPORT_SAMPLE_DIR}/sample.xlsx`, xlsx);
      writeFileSync(`${process.env.EXPORT_SAMPLE_DIR}/sample.pdf`, pdf);
    }
  });
});
