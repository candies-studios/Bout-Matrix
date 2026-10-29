import { useState } from 'react';
import { supabase, friendlyError } from '@/lib/supabase';
import { Alert, Button, Select } from '@/components/ui';
import { Checkbox, Modal } from '@/components/more';
import {
  BOUT_COLUMNS, buildTable, DEFAULT_BOUT_COLUMNS, DEFAULT_FIGHTER_COLUMNS, downloadExcel, downloadPdf, FIGHTER_COLUMNS, type ExportBout,
} from '@/lib/exportBouts';

const SCOPES = {
  confirmed: { label: 'Confirmed bouts (the fight card)', statuses: ['confirmed', 'completed'] },
  main: { label: 'Main card only', statuses: ['confirmed', 'completed'] },
  all: {
    label: 'All bouts that are not cancelled (incl. drafts and offers)',
    statuses: ['draft', 'offer_sent', 'awaiting_responses', 'accepted_one', 'accepted_both', 'under_review', 'declined', 'expired', 'confirmed', 'completed'],
  },
} as const;
type Scope = keyof typeof SCOPES;

const STORE = 'bout-export-columns-v1';
function loadSaved(): { bout: string[]; fighter: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (v && Array.isArray(v.bout) && Array.isArray(v.fighter)) return v;
  } catch {
    // storage unavailable — use defaults
  }
  return { bout: DEFAULT_BOUT_COLUMNS, fighter: DEFAULT_FIGHTER_COLUMNS };
}

/** "Export" button: choose which bouts and columns, then download Excel or PDF. */
export function ExportBouts({ eventId, eventName }: { eventId: string; eventName: string }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('confirmed');
  const [cols, setCols] = useState(loadSaved);
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (group: 'bout' | 'fighter', key: string, on: boolean) =>
    setCols((c) => {
      const next = { ...c, [group]: on ? [...c[group], key] : c[group].filter((k) => k !== key) };
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {
        // not saved — fine
      }
      return next;
    });

  async function run(kind: 'xlsx' | 'pdf') {
    setBusy(kind);
    setErr(null);
    try {
      const { data, error } = await supabase.rpc('export_event_bouts', { p_event: eventId, p_statuses: [...SCOPES[scope].statuses] });
      if (error) throw new Error(friendlyError(error));
      let bouts = (data ?? []) as ExportBout[];
      if (scope === 'main') bouts = bouts.filter((b) => b.card_segment === 'main_card');
      if (!bouts.length) throw new Error(scope === 'main' ? 'No bouts are on the main card yet. Pick them on the Fight cards page.' : 'There are no bouts to export.');
      const table = buildTable(bouts, cols.bout, cols.fighter);
      const subtitle = `${SCOPES[scope].label} · ${bouts.length} bout${bouts.length === 1 ? '' : 's'} · exported ${new Date().toLocaleString()}`
        + (cols.fighter.includes('record') ? ' · * record self-reported, not verified' : '');
      await (kind === 'xlsx' ? downloadExcel(table, eventName, subtitle) : downloadPdf(table, eventName, subtitle));
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  const nothing = cols.bout.length + cols.fighter.length === 0;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>Export</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Export bout list" wide>
        <div className="flex flex-col gap-5">
          {err && <Alert>{err}</Alert>}
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Which bouts
            <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              {Object.entries(SCOPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </label>
          <div className="grid gap-5 md:grid-cols-2">
            <fieldset>
              <legend className="mb-2 font-semibold">Bout columns</legend>
              <div className="flex flex-col gap-2">
                {BOUT_COLUMNS.map((c) => (
                  <Checkbox key={c.key} id={`exp-b-${c.key}`} label={c.label} checked={cols.bout.includes(c.key)} onChange={(v) => toggle('bout', c.key, v)} />
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 font-semibold">Fighter columns <span className="font-normal text-ink-400">(for both red and blue corner)</span></legend>
              <div className="flex flex-col gap-2">
                {FIGHTER_COLUMNS.map((c) => (
                  <Checkbox key={c.key} id={`exp-f-${c.key}`} label={c.label} checked={cols.fighter.includes(c.key)} onChange={(v) => toggle('fighter', c.key, v)}
                            description={['phone', 'email', 'dob', 'legal_name'].includes(c.key) ? 'Private — only share with staff' : undefined} />
                ))}
              </div>
            </fieldset>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void run('xlsx')} loading={busy === 'xlsx'} disabled={nothing || !!busy}>Download Excel</Button>
            <Button variant="secondary" onClick={() => void run('pdf')} loading={busy === 'pdf'} disabled={nothing || !!busy}>Download PDF</Button>
            <button type="button" className="text-sm text-ink-400 underline-offset-2 hover:underline"
                    onClick={() => { setCols({ bout: DEFAULT_BOUT_COLUMNS, fighter: DEFAULT_FIGHTER_COLUMNS }); try { localStorage.removeItem(STORE); } catch { /* ignore */ } }}>
              Reset columns
            </button>
          </div>
          <p className="text-xs text-ink-400">Your column choice is remembered on this computer. Main card bouts come first, in card order.</p>
        </div>
      </Modal>
    </>
  );
}
