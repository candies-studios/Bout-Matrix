import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CLASSIFICATION_LABELS, type Classification, type Evaluation } from '@domain/matchmaking.ts';
import { supabase, friendlyError } from '@/lib/supabase';
import { formatDateTime, formatWeight, humanize } from '@/lib/format';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Textarea, type Tone } from '@/components/ui';
import { Modal } from '@/components/more';
import { EventPicker } from '@/components/EventPicker';
import { useSelectedEvent } from '@/hooks/useSelectedEvent';
import { Loading } from '@/components/Loading';
import { useEventRoster, type WC } from '@/hooks/useEventRoster';
import { useMatchSuggestions, type MatchSuggestion } from '@/hooks/useMatchSuggestions';

const TONE: Record<Classification, Tone> = { strong_candidate: 'ok', possible_candidate: 'info', requires_review: 'warn', ineligible: 'danger' };


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
      // Evaluated again on the server; the browser never supplies the evaluation.
      const { data, error } = await supabase.rpc('create_bout', {
        p: {
          event_id: eventId, fighter_a_id: pair[0], fighter_b_id: pair[1],
          weight_class_id: wc || null,
          rounds: rounds ? Number(rounds) : undefined, round_minutes: minutes ? Number(minutes) : undefined,
          contracted_weight_g: contract ? Math.round(Number(contract) * 1000) : null,
          override_reason: override || undefined, suggestion_id: suggestionId ?? null, replaces_bout_id: replacesBoutId ?? null, admin_notes: notes || undefined,
        },
      });
      if (error) throw new Error(friendlyError(error));
      navigate(`/admin/bouts?event=${eventId}&bout=${(data as { id: string }).id}`);
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
                    <option key={w.id} value={w.id}>{w.name}{w.division ? ` (${humanize(w.division)})` : ''}</option>
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

export function SuggestionRow({ s, onCreate, onCompare, onDismiss, createLabel = 'Create bout' }: {
  s: MatchSuggestion; onCreate: () => void; onCompare: () => void; onDismiss?: () => void; createLabel?: string;
}) {
  const e = s.evaluation;
  const side = (f: MatchSuggestion['fighter_a']) => (
    <div>
      <p className="font-display text-xl font-bold uppercase">{f.fight_name}</p>
      <p className="text-xs text-ink-400">{f.fighter_code} · {formatWeight(f.weight_g)}</p>
    </div>
  );
  const warnings = e.issues.filter((i) => i.severity !== 'info');
  return (
    <li className="rounded-lg border border-ink-700 bg-ink-900 p-4">
      <div className="grid items-center gap-3 md:grid-cols-[1fr_auto_1fr_auto]">
        {side(s.fighter_a)}
        <span className="text-center font-display text-xl text-accent-500">VS</span>
        {side(s.fighter_b)}
        <div className="flex flex-col items-end gap-1">
          <ClassificationBadge c={s.classification} />
          <span className="font-display text-2xl font-bold">{s.score ?? '—'}</span>
        </div>
      </div>
      <p className="mt-2 text-sm text-ink-300">{e.explanation.join(' ')}</p>
      {warnings.length > 0 && <p className="mt-1 text-sm text-amber-300">{warnings.map((i) => i.message).join(' · ')}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={onCreate}>{createLabel}</Button>
        <Button variant="secondary" onClick={onCompare}>Compare</Button>
        {onDismiss && <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>}
      </div>
    </li>
  );
}

export function Matchmaking() {
  const { eventId, setEventId, events } = useSelectedEvent();
  const roster = useEventRoster(eventId);
  const q = useMatchSuggestions(eventId);
  const [cls, setCls] = useState<string>('');
  const [wcFilter, setWcFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [detail, setDetail] = useState<MatchSuggestion | null>(null);
  const [creating, setCreating] = useState<MatchSuggestion | null>(null);

  const names = useMemo(
    () => Object.fromEntries((q.data?.suggestions ?? []).flatMap((s) => [[s.fighter_a_id, s.fighter_a.fight_name], [s.fighter_b_id, s.fighter_b.fight_name]])),
    [q.data],
  );

  async function dismiss(id: string) {
    const { error } = await supabase.rpc('dismiss_suggestion', { p_suggestion: id });
    setMsg(error ? friendlyError(error) : null);
    void q.reload();
  }

  const rows = (q.data?.suggestions ?? []).filter((s) => (!cls || s.classification === cls) && (!wcFilter || s.evaluation.proposed_weight_class?.id === wcFilter));
  const st = q.data?.stats;

  return (
    <div>
      <PageHeader
        title="Matchmaking"
        description="Suggested bouts update automatically as fighters are approved, weighed or booked. You approve every bout."
        actions={<EventPicker eventId={eventId} setEventId={setEventId} events={events} />}
      />
      {msg && <div className="mb-4"><Alert>{msg}</Alert></div>}
      {!eventId ? (
        <EmptyState title="No events available" />
      ) : (
        <Loading loading={q.loading && !q.data} error={q.error}>
          {q.data && st && (
            <div className="flex flex-col gap-6">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {([
                  ['Registrants', st.registrants],
                  ['Approved', st.approved],
                  ['Ready to match', st.ready],
                  ['Awaiting review', st.awaiting_review],
                ] as const).map(([label, n]) => (
                  <Card key={label} className="p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</p>
                    <p className="font-display text-3xl font-bold">{n}</p>
                  </Card>
                ))}
              </div>
              <div className="grid items-center gap-3 sm:grid-cols-[16rem_16rem_1fr]">
                <Select aria-label="Classification" value={cls} onChange={(e) => setCls(e.target.value)}>
                  <option value="">All suggestions</option>
                  {(['strong_candidate', 'possible_candidate', 'requires_review'] as Classification[]).map((c) => <option key={c} value={c}>{CLASSIFICATION_LABELS[c]}</option>)}
                </Select>
                <Select aria-label="Weight class" value={wcFilter} onChange={(e) => setWcFilter(e.target.value)}>
                  <option value="">All weight classes</option>
                  {(roster.data?.classes ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}{w.division ? ` (${humanize(w.division)})` : ''}</option>)}
                </Select>
                <span className="text-xs text-ink-400" aria-live="polite">
                  {rows.length} suggestion{rows.length === 1 ? '' : 's'} · updated {formatDateTime(q.data.refreshed_at)}
                </span>
              </div>
              {rows.length === 0 ? (
                <EmptyState title="No suggested bouts yet">
                  {st.ready < 2
                    ? `Only ${st.ready} fighter${st.ready === 1 ? ' is' : 's are'} ready to match. Fighters need an approved registration, availability and no medical "not cleared" status — approve registrations under Fighters and suggestions appear here automatically.`
                    : 'No compatible pairings among the ready fighters (division, level, weight, age and experience rules). Suggestions appear automatically as more fighters are approved.'}
                </EmptyState>
              ) : (
                <ul className="flex flex-col gap-3">
                  {rows.map((s) => (
                    <SuggestionRow key={s.id} s={s} onCreate={() => setCreating(s)} onCompare={() => setDetail(s)} onDismiss={() => void dismiss(s.id)} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </Loading>
      )}
      <CompareModal s={detail} onClose={() => setDetail(null)} />
      <CreateBoutModal
        eventId={eventId}
        pair={creating ? [creating.fighter_a_id, creating.fighter_b_id] : null}
        evaluation={creating?.evaluation ?? null}
        suggestionId={creating?.id}
        classes={roster.data?.classes ?? []}
        names={names}
        onClose={() => setCreating(null)}
      />
    </div>
  );
}

export function CompareModal({ s, onClose }: { s: MatchSuggestion | null; onClose: () => void }) {
  return (
    <Modal open={!!s} onClose={onClose} title="Compare fighters" wide>
      {s && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            {[s.fighter_a, s.fighter_b].map((f) => (
              <div key={f.fighter_code} className="rounded border border-ink-700 p-3">
                <p className="font-display text-xl font-bold uppercase">{f.fight_name}</p>
                <p className="text-sm text-ink-400">{f.fighter_code}</p>
                <p className="mt-2 text-sm">Weight: {formatWeight(f.weight_g)}</p>
                <p className="text-sm">Division: {humanize(f.division)}</p>
              </div>
            ))}
          </div>
          <EvaluationDetails e={s.evaluation} />
          <p className="text-xs text-ink-400">Records: {s.evaluation.components.record.detail} (* = self-reported).</p>
        </div>
      )}
    </Modal>
  );
}
