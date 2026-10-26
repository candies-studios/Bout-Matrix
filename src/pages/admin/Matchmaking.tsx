import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CLASSIFICATION_LABELS, type Classification, type Evaluation } from '@domain/matchmaking.ts';
import { supabase, friendlyError } from '@/lib/supabase';
import { callFunction } from '@/lib/api';
import { must, useAsync } from '@/hooks/useAsync';
import { formatDateTime, formatWeight } from '@/lib/format';
import { Alert, Badge, Button, EmptyState, Field, Input, PageHeader, Select, Textarea, type Tone } from '@/components/ui';
import { Modal } from '@/components/more';
import { EventPicker } from '@/components/EventPicker';
import { useSelectedEvent } from '@/hooks/useSelectedEvent';
import { Loading } from '@/components/Loading';
import { useEventRoster, type WC } from '@/hooks/useEventRoster';

const TONE: Record<Classification, Tone> = { strong_candidate: 'ok', possible_candidate: 'info', requires_review: 'warn', ineligible: 'danger' };

interface Suggestion { id: string; fighter_a_id: string; fighter_b_id: string; score: number | null; classification: Classification; evaluation: Evaluation; generated_at: string }

export function ClassificationBadge({ c }: { c: Classification }) {
  return <Badge tone={TONE[c]}>{CLASSIFICATION_LABELS[c]}</Badge>;
}

export function EvaluationDetails({ e }: { e: Evaluation }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <ClassificationBadge c={e.classification} />
        <span className="font-display text-2xl font-bold">{e.score == null ? 'No score' : `${e.score} / 100`}</span>
        {e.proposed_weight_class && <span className="text-ink-400">Proposed: {e.proposed_weight_class.name}</span>}
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {Object.entries(e.components).map(([k, c]) => (
          <li key={k} className="flex justify-between gap-2 rounded bg-ink-850 px-3 py-1.5">
            <span className="capitalize text-ink-400">{k}</span>
            <span>{c.score == null ? '—' : `${Math.round(c.score * 100)}%`} <span className="text-ink-400">{c.detail}</span></span>
          </li>
        ))}
      </ul>
      {e.explanation.length > 0 && <p className="text-ink-300">{e.explanation.join(' ')}</p>}
      {e.issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {e.issues.map((i, n) => (
            <li key={n} className={i.severity === 'block' ? 'text-accent-400' : i.severity === 'review' ? 'text-amber-300' : 'text-ink-400'}>
              {i.severity === 'block' ? '⛔' : i.severity === 'review' ? '⚠️' : 'ℹ️'} {i.message}
            </li>
          ))}
        </ul>
      )}
      {e.missing.length > 0 && <p className="text-amber-300">Missing: {e.missing.join('; ')}</p>}
      <p className="text-xs text-ink-400">The score supports a matchmaker's judgement. It is not a safety guarantee.</p>
    </div>
  );
}

export function CreateBoutModal({
  eventId, pair, evaluation, suggestionId, replacesBoutId, classes, names, onClose,
}: {
  eventId: string; pair: [string, string] | null; evaluation: Evaluation | null; suggestionId?: string; replacesBoutId?: string;
  classes: WC[]; names: Record<string, string>; onClose: () => void;
}) {
  const navigate = useNavigate();
  const [wc, setWc] = useState('');
  const [rounds, setRounds] = useState('');
  const [minutes, setMinutes] = useState('');
  const [contract, setContract] = useState('');
  const [override, setOverride] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsOverride = evaluation && (evaluation.classification === 'requires_review' || evaluation.classification === 'ineligible');

  async function create() {
    if (!pair) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await callFunction<{ bout: { id: string } }>('bout-create', {
        event_id: eventId, fighter_a_id: pair[0], fighter_b_id: pair[1],
        weight_class_id: wc || evaluation?.proposed_weight_class?.id || null,
        rounds: rounds ? Number(rounds) : undefined, round_minutes: minutes ? Number(minutes) : undefined,
        contracted_weight_g: contract ? Math.round(Number(contract) * 1000) : null,
        override_reason: override || undefined, suggestion_id: suggestionId ?? null, replaces_bout_id: replacesBoutId ?? null, admin_notes: notes || undefined,
      });
      navigate(`/admin/bouts?event=${eventId}&bout=${r.bout.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={!!pair} onClose={onClose} title={replacesBoutId ? 'Create replacement bout' : 'Create bout'} wide>
      {pair && (
        <div className="flex flex-col gap-4">
          <p className="font-display text-2xl font-bold uppercase">
            {names[pair[0]]} <span className="text-accent-500">vs</span> {names[pair[1]]}
          </p>
          {evaluation && <EvaluationDetails e={evaluation} />}
          {err && <Alert>{err}</Alert>}
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Weight class">
              {({ id }) => (
                <Select id={id} value={wc} onChange={(e) => setWc(e.target.value)}>
                  <option value="">{evaluation?.proposed_weight_class ? `Proposed (${evaluation.proposed_weight_class.name})` : 'Choose…'}</option>
                  {classes.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}{w.division ? ` (${w.division})` : ''}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Contracted weight (kg)">{({ id }) => <Input id={id} type="number" step="0.1" value={contract} onChange={(e) => setContract(e.target.value)} />}</Field>
            <Field label="Rounds" hint="Default from event">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={1} max={5} value={rounds} onChange={(e) => setRounds(e.target.value)} />}</Field>
            <Field label="Minutes / round">{({ id }) => <Input id={id} type="number" min={1} max={10} value={minutes} onChange={(e) => setMinutes(e.target.value)} />}</Field>
          </div>
          {needsOverride && (
            <Field label="Override reason" required hint="This pairing needs review. Your reason is stored with the bout and in the audit log (10+ characters).">
              {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={override} onChange={(e) => setOverride(e.target.value)} />}
            </Field>
          )}
          <Field label="Admin notes (internal)">{({ id }) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-16" />}</Field>
          <p className="text-sm text-ink-400">The bout is created as a draft. Offers are sent separately, and both acceptances still require your confirmation.</p>
          <Button onClick={() => void create()} loading={busy} disabled={Boolean(needsOverride && override.trim().length < 10)} className="self-start">
            Create draft bout
          </Button>
        </div>
      )}
    </Modal>
  );
}

export function Matchmaking() {
  const { eventId, setEventId, events } = useSelectedEvent();
  const roster = useEventRoster(eventId);
  const [cls, setCls] = useState<string>('');
  const [wcFilter, setWcFilter] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Evaluation | null>(null);
  const [creating, setCreating] = useState<{ pair: [string, string]; evaluation: Evaluation | null; suggestionId?: string } | null>(null);
  const [manual, setManual] = useState<[string, string]>(['', '']);
  const sugg = useAsync(async () => {
    if (!eventId) return [];
    return must(await supabase.from('matchmaking_suggestions').select('id, fighter_a_id, fighter_b_id, score, classification, evaluation, generated_at').eq('event_id', eventId).eq('status', 'open').order('score', { ascending: false, nullsFirst: false })) as Suggestion[];
  }, [eventId]);

  const names = useMemo(() => Object.fromEntries((roster.data?.regs ?? []).map((r) => [r.fighter_id, r.fighters?.fight_name ?? r.fighter_id])), [roster.data]);
  const regBy = useMemo(() => Object.fromEntries((roster.data?.regs ?? []).map((r) => [r.fighter_id, r])), [roster.data]);

  async function generate() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await callFunction<{ count: number; candidates: number }>('matchmaking-generate', { event_id: eventId });
      setMsg({ tone: 'ok', text: `Evaluated ${r.candidates} registrants; ${r.count} pairings are eligible or need review.` });
      void sugg.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function evaluateManual() {
    if (!manual[0] || !manual[1] || manual[0] === manual[1]) return setMsg({ tone: 'danger', text: 'Choose two different fighters.' });
    try {
      const r = await callFunction<{ evaluation: Evaluation }>('matchmaking-generate', { event_id: eventId, fighter_a_id: manual[0], fighter_b_id: manual[1] });
      setCreating({ pair: manual, evaluation: r.evaluation });
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  }
  async function dismiss(id: string) {
    const { error } = await supabase.from('matchmaking_suggestions').update({ status: 'dismissed' }).eq('id', id);
    if (error) setMsg({ tone: 'danger', text: friendlyError(error) });
    void sugg.reload();
  }

  const rows = (sugg.data ?? []).filter((s) => (!cls || s.classification === cls) && (!wcFilter || s.evaluation.proposed_weight_class?.id === wcFilter));
  const approved = (roster.data?.regs ?? []).filter((r) => r.status === 'approved').sort((a, b) => (a.declared_weight_g ?? 0) - (b.declared_weight_g ?? 0));

  return (
    <div>
      <PageHeader title="Matchmaking" actions={<EventPicker eventId={eventId} setEventId={setEventId} events={events} />} />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!eventId ? (
        <EmptyState title="No events available" />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
            <Button onClick={() => void generate()} loading={busy}>Generate suggestions</Button>
            <Select aria-label="Classification" value={cls} onChange={(e) => setCls(e.target.value)} className="w-56">
              <option value="">All classifications</option>
              {(['strong_candidate', 'possible_candidate', 'requires_review'] as Classification[]).map((c) => <option key={c} value={c}>{CLASSIFICATION_LABELS[c]}</option>)}
            </Select>
            <Select aria-label="Weight class" value={wcFilter} onChange={(e) => setWcFilter(e.target.value)} className="w-56">
              <option value="">All weight classes</option>
              {(roster.data?.classes ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}{w.division ? ` (${w.division})` : ''}</option>)}
            </Select>
            {sugg.data?.[0] && <span className="text-xs text-ink-400">Generated {formatDateTime(sugg.data[0].generated_at)}</span>}
          </div>

          <section className="rounded-lg border border-ink-700 bg-ink-900 p-4">
            <h2 className="mb-3 text-xl font-semibold uppercase">Manual matchup</h2>
            <div className="grid gap-2 md:grid-cols-[1fr_auto_1fr_auto]">
              {[0, 1].map((i) => (
                <Select key={i} aria-label={`Fighter ${i === 0 ? 'A' : 'B'}`} value={manual[i]} onChange={(e) => setManual((m) => (i === 0 ? [e.target.value, m[1]] : [m[0], e.target.value]))}>
                  <option value="">Choose fighter {i === 0 ? 'A' : 'B'}…</option>
                  {approved.map((r) => (
                    <option key={r.fighter_id} value={r.fighter_id}>
                      {r.fighters?.fight_name} · {formatWeight(r.declared_weight_g)} · {r.division}
                    </option>
                  ))}
                </Select>
              )).flatMap((el, i) => (i === 0 ? [el, <span key="vs" className="self-center text-center font-display text-xl text-accent-500">VS</span>] : [el]))}
              <Button variant="secondary" onClick={() => void evaluateManual()}>Evaluate & create</Button>
            </div>
            <p className="mt-2 text-xs text-ink-400">Only approved registrants are listed. The pairing is evaluated on the server before a bout can be created.</p>
          </section>

          <Loading loading={sugg.loading || roster.loading} error={sugg.error || roster.error}>
            {rows.length === 0 ? (
              <EmptyState title="No suggestions">Approve registrations, then generate suggestions.</EmptyState>
            ) : (
              <ul className="flex flex-col gap-3">
                {rows.map((s) => {
                  const e = s.evaluation;
                  const side = (id: string) => (
                    <div>
                      <p className="font-display text-xl font-bold uppercase">{names[id] ?? 'Unknown'}</p>
                      <p className="text-xs text-ink-400">{regBy[id]?.fighters?.fighter_code} · {formatWeight(regBy[id]?.declared_weight_g)}</p>
                    </div>
                  );
                  return (
                    <li key={s.id} className="rounded-lg border border-ink-700 bg-ink-900 p-4">
                      <div className="grid items-center gap-3 md:grid-cols-[1fr_auto_1fr_auto]">
                        {side(s.fighter_a_id)}
                        <span className="text-center font-display text-xl text-accent-500">VS</span>
                        {side(s.fighter_b_id)}
                        <div className="flex flex-col items-end gap-1">
                          <ClassificationBadge c={s.classification} />
                          <span className="font-display text-2xl font-bold">{s.score ?? '—'}</span>
                        </div>
                      </div>
                      <p className="mt-2 text-sm text-ink-300">{e.explanation.join(' ')}</p>
                      {e.issues.filter((i) => i.severity !== 'info').length > 0 && (
                        <p className="mt-1 text-sm text-amber-300">{e.issues.filter((i) => i.severity !== 'info').map((i) => i.message).join(' · ')}</p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button onClick={() => setCreating({ pair: [s.fighter_a_id, s.fighter_b_id], evaluation: e, suggestionId: s.id })}>Create bout</Button>
                        <Button variant="secondary" onClick={() => setDetail(e)}>Compare</Button>
                        <Button variant="ghost" onClick={() => void dismiss(s.id)}>Dismiss</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Loading>
        </div>
      )}
      <Modal open={!!detail} onClose={() => setDetail(null)} title="Compare fighters" wide>
        {detail && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              {[detail.fighter_a_id, detail.fighter_b_id].map((id) => (
                <div key={id} className="rounded border border-ink-700 p-3">
                  <p className="font-display text-xl font-bold uppercase">{names[id]}</p>
                  <p className="text-sm text-ink-400">{regBy[id]?.fighters?.fighter_code}</p>
                  <p className="mt-2 text-sm">Weight: {formatWeight(regBy[id]?.declared_weight_g)}</p>
                  <p className="text-sm">Division: {regBy[id]?.division}</p>
                </div>
              ))}
            </div>
            <EvaluationDetails e={detail} />
            <p className="text-xs text-ink-400">Records: {detail.components.record.detail} (* = self-reported).</p>
          </div>
        )}
      </Modal>
      <CreateBoutModal
        eventId={eventId}
        pair={creating?.pair ?? null}
        evaluation={creating?.evaluation ?? null}
        suggestionId={creating?.suggestionId}
        classes={roster.data?.classes ?? []}
        names={names}
        onClose={() => setCreating(null)}
      />
    </div>
  );
}
