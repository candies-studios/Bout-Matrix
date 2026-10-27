import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { availableManualActions, BOUT_STATUS_LABELS, REASON_REQUIRED, termsEditable, type BoutStatus } from '@domain/boutStatus.ts';
import { supabase, friendlyError, siteUrl } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { must, useAsync } from '@/hooks/useAsync';
import { formatDateTime, formatWeight, humanize } from '@/lib/format';
import { Alert, Badge, Button, EmptyState, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { KeyValue, Modal, Section, Table } from '@/components/more';
import { EventPicker } from '@/components/EventPicker';
import { useSelectedEvent } from '@/hooks/useSelectedEvent';
import { Loading } from '@/components/Loading';
import { BoutStatusBadge } from '@/components/StatusBadge';
import { CompareModal, CreateBoutModal, EvaluationDetails, SuggestionRow } from './Matchmaking';
import { useMatchSuggestions, type MatchSuggestion } from '@/hooks/useMatchSuggestions';
import { useEventRoster } from '@/hooks/useEventRoster';
import { BOUT_SELECT, canManageEvent, type BoutRow } from '@/lib/bouts';

const GROUPS: { label: string; statuses: BoutStatus[] }[] = [
  { label: 'Needs attention', statuses: ['accepted_both', 'declined', 'expired', 'under_review'] },
  { label: 'Offers out', statuses: ['offer_sent', 'awaiting_responses', 'accepted_one'] },
  { label: 'Drafts', statuses: ['draft'] },
  { label: 'Confirmed', statuses: ['confirmed', 'completed'] },
  { label: 'Cancelled', statuses: ['cancelled'] },
];

export function Bouts() {
  const { eventId, setEventId, events } = useSelectedEvent();
  const [params, setParams] = useSearchParams();
  const openId = params.get('bout');
  const q = useAsync(async () => (eventId ? (must(await supabase.from('bouts').select(BOUT_SELECT).eq('event_id', eventId).order('created_at', { ascending: false })) as unknown as BoutRow[]) : []), [eventId]);
  const setOpen = (id: string | null) => {
    const n = new URLSearchParams(params);
    if (id) n.set('bout', id);
    else n.delete('bout');
    setParams(n);
  };
  const open = q.data?.find((b) => b.id === openId) ?? null;

  return (
    <div>
      <PageHeader title="Bouts" actions={<EventPicker eventId={eventId} setEventId={setEventId} events={events} />} />
      <Loading loading={q.loading} error={q.error}>
        {!q.data?.length ? (
          <EmptyState title="No bouts yet">Create bouts from the Matchmaking page.</EmptyState>
        ) : (
          <div className="flex flex-col gap-6">
            {GROUPS.map((g) => {
              const rows = q.data!.filter((b) => g.statuses.includes(b.status));
              if (!rows.length) return null;
              return (
                <section key={g.label}>
                  <h2 className="mb-2 text-xl font-semibold uppercase">{g.label} <span className="text-ink-400">({rows.length})</span></h2>
                  <Table caption={g.label}>
                    <thead><tr><th>Bout</th><th>Fighters</th><th>Class</th><th>Status</th><th>Offer expires</th><th>Published</th></tr></thead>
                    <tbody>
                      {rows.map((b) => (
                        <tr key={b.id}>
                          <td><button className="font-semibold hover:underline" onClick={() => setOpen(b.id)}>{b.bout_code}</button></td>
                          <td>{b.fighter_a?.fight_name} <span className="text-accent-500">vs</span> {b.fighter_b?.fight_name}</td>
                          <td>{b.weight_classes?.name ?? 'Catchweight'}</td>
                          <td><BoutStatusBadge status={b.status} /></td>
                          <td>{b.offer_expires_at && ['offer_sent', 'awaiting_responses', 'accepted_one'].includes(b.status) ? formatDateTime(b.offer_expires_at) : '—'}</td>
                          <td>{b.is_published ? <Badge tone="ok">Yes</Badge> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </section>
              );
            })}
          </div>
        )}
      </Loading>
      {open && <BoutDetail bout={open} onClose={() => setOpen(null)} onChanged={q.reload} />}
    </div>
  );
}

const offerUrl = (token: string) => `${siteUrl}/offers/${token}`;

function whatsappUrl(fighter: string, bout: BoutRow, url: string, expiresAt: string) {
  const text = `Hi ${fighter}, you have a bout offer (${bout.bout_code}, ${bout.weight_classes?.name ?? 'Catchweight'}, ${bout.rounds} x ${bout.round_minutes} min). `
    + `Open your personal link to see the details and accept or decline before ${formatDateTime(expiresAt)}: ${url}\n\nThis link is only for you, please don't share it.`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

interface Offer { id: string; fighter_id: string; corner: string; offer_version: number; status: string; expires_at: string; sent_at: string | null; first_viewed_at: string | null; responded_at: string | null; revoked_reason: string | null; reminder_sent_at: string | null }

function BoutDetail({ bout, onClose, onChanged }: { bout: BoutRow; onClose: () => void; onChanged: () => void }) {
  const { access } = useAuth();
  const admin = canManageEvent(access, bout.event_id);
  const roster = useEventRoster(bout.event_id);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [transition, setTransition] = useState<BoutStatus | null>(null);
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [showReplacements, setShowReplacements] = useState(false);
  const [creating, setCreating] = useState<MatchSuggestion | null>(null);
  const [comparing, setComparing] = useState<MatchSuggestion | null>(null);
  // Automatic suggestions for this event; replacements are the ones involving either fighter.
  const suggestions = useMatchSuggestions(showReplacements ? bout.event_id : '');
  const replacements = (suggestions.data?.suggestions ?? []).filter((x) =>
    [x.fighter_a_id, x.fighter_b_id].some((id) => id === bout.fighter_a_id || id === bout.fighter_b_id),
  );

  const extra = useAsync(async () => {
    const offers = must(await supabase.from('bout_offers').select('id, fighter_id, corner, offer_version, status, expires_at, sent_at, first_viewed_at, responded_at, revoked_reason, reminder_sent_at').eq('bout_id', bout.id).order('offer_version', { ascending: false }).order('corner')) as Offer[];
    const responses = must(await supabase.from('bout_responses').select('id, offer_id, response, decline_reason, responded_at').eq('bout_id', bout.id)) as { id: string; offer_id: string; response: string; decline_reason: string | null; responded_at: string }[];
    const history = must(await supabase.from('bout_status_history').select('id, from_status, to_status, actor_kind, reason, created_at').eq('bout_id', bout.id).order('id', { ascending: false })) as { id: number; from_status: BoutStatus | null; to_status: BoutStatus; actor_kind: string; reason: string | null; created_at: string }[];
    // Personal links for open offers, so the admin can copy them or share them on WhatsApp.
    const links: Record<string, string> = {};
    await Promise.all(
      offers
        .filter((o) => o.offer_version === bout.offer_version && o.status === 'pending' && new Date(o.expires_at) > new Date())
        .map(async (o) => {
          const { data } = await supabase.rpc('get_offer_link', { p_offer: o.id });
          const token = (data as { token?: string } | null)?.token;
          if (token) links[o.id] = offerUrl(token);
        }),
    );
    return { offers, responses, history, links };
  }, [bout.id, bout.updated_at]);

  const done = (text: string, error?: unknown) => {
    setMsg(error ? { tone: 'danger', text: error instanceof Error && !(error as { code?: string }).code ? error.message : friendlyError(error) } : { tone: 'ok', text });
    if (!error) {
      onChanged();
      void extra.reload();
    }
  };
  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMsg({ tone: 'ok', text: 'Link copied. Paste it into a message to the fighter.' });
    } catch {
      window.prompt('Copy this link:', url);
    }
  }
  const name = (id: string) => (id === bout.fighter_a_id ? bout.fighter_a?.fight_name : bout.fighter_b?.fight_name);

  async function doTransition() {
    if (!transition) return;
    setBusy(true);
    const { error } = await supabase.rpc('transition_bout', { p_bout: bout.id, p_to: transition, p_reason: reason || null, p_expected_updated_at: bout.updated_at });
    setBusy(false);
    done(`Bout moved to ${BOUT_STATUS_LABELS[transition]}.`, error);
    if (!error) {
      setTransition(null);
      setReason('');
    }
  }
  async function sendOffers() {
    setBusy(true);
    const { error } = await supabase.rpc('issue_offers', { p_bout: bout.id, p_hours: hours ? Number(hours) : null });
    setBusy(false);
    done('Offers created. Send each fighter their personal link below (Copy link or WhatsApp). Emails go out automatically once email sending is set up.', error);
  }
  async function saveTerms(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const { error } = await supabase
      .from('bouts')
      .update({
        weight_class_id: d.weight_class_id || null, rounds: Number(d.rounds), round_minutes: Number(d.round_minutes),
        contracted_weight_g: d.contracted ? Math.round(Number(d.contracted) * 1000) : null, rules_text: d.rules_text || null, admin_notes: d.admin_notes || null,
      })
      .eq('id', bout.id);
    done(bout.status === 'under_review' ? 'Terms saved. Earlier acceptances no longer count — send new offers.' : 'Terms saved.', error);
  }
  async function saveNotes(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { error } = await supabase.from('bouts').update({ admin_notes: String(new FormData(e.currentTarget).get('admin_notes') || '') || null }).eq('id', bout.id);
    done('Notes saved.', error);
  }

  const actions = availableManualActions(bout.status, admin);
  const canOffer = ['draft', 'expired', 'under_review'].includes(bout.status);
  const editable = termsEditable(bout.status);
  // Declined/expired bouts release their fighters, so the automatic engine already suggests new opponents.
  const canReplace = admin && ['declined', 'expired'].includes(bout.status);
  const currentOffers = extra.data?.offers.filter((o) => o.offer_version === bout.offer_version) ?? [];

  return (
    <Modal open onClose={onClose} title={`${bout.bout_code}`} wide>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-display text-2xl font-bold uppercase">
            {bout.fighter_a?.fight_name} <span className="text-sm font-normal text-ink-400">{bout.fighter_a?.fighter_code}</span>{' '}
            <span className="text-accent-500">vs</span> {bout.fighter_b?.fight_name} <span className="text-sm font-normal text-ink-400">{bout.fighter_b?.fighter_code}</span>
          </p>
          <BoutStatusBadge status={bout.status} />
          {bout.is_published && <Badge tone="ok">Published</Badge>}
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {bout.status === 'accepted_both' && <Alert tone="warn">Both fighters accepted. The bout is not confirmed until an event administrator confirms it.</Alert>}
        {bout.status === 'declined' && <Alert tone="warn">A fighter declined. Review the bout: re-offer, replace the opponent, or cancel.</Alert>}

        <KeyValue
          items={[
            ['Weight class', bout.weight_classes?.name ?? 'Catchweight'],
            ['Contracted weight', bout.contracted_weight_g ? formatWeight(bout.contracted_weight_g) : '—'],
            ['Format', `${bout.rounds} × ${bout.round_minutes} min`],
            ['Offer version', String(bout.offer_version)],
            ['Override reason', bout.override_reason],
            ['Cancellation reason', bout.cancel_reason],
          ]}
        />

        <div className="flex flex-wrap gap-2">
          {canOffer && (
            <span className="flex items-center gap-2">
              <Input aria-label="Offer valid for hours" type="number" min={1} max={720} placeholder="Hours (default)" value={hours} onChange={(e) => setHours(e.target.value)} className="w-36" />
              <Button onClick={() => void sendOffers()} loading={busy}>{bout.offer_version ? 'Send new offers' : 'Send offers'}</Button>
            </span>
          )}
          {actions.map((a) => (
            <Button key={a} variant={a === 'cancelled' ? 'danger' : a === 'confirmed' ? 'primary' : 'secondary'} onClick={() => setTransition(a)}>
              {a === 'confirmed' ? 'Confirm bout' : a === 'under_review' ? 'Move to review' : a === 'cancelled' ? 'Cancel bout' : a === 'completed' ? 'Mark completed' : 'Back to draft'}
            </Button>
          ))}
          {canReplace && (
            <Button variant="secondary" onClick={() => setShowReplacements((v) => !v)}>Suggested replacement opponents</Button>
          )}
        </div>

        {transition && (
          <div className="rounded-md border border-ink-700 p-4">
            <p className="mb-2 font-semibold">{transition === 'confirmed' ? 'Confirm this bout? Both fighters will be emailed.' : `Move to “${BOUT_STATUS_LABELS[transition]}”?`}</p>
            <Field label="Reason" required={REASON_REQUIRED.includes(transition)} hint="Recorded in the status history and audit log.">
              {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-16" />}
            </Field>
            <div className="mt-3 flex gap-2">
              <Button onClick={() => void doTransition()} loading={busy} disabled={REASON_REQUIRED.includes(transition) && !reason.trim()}>Confirm</Button>
              <Button variant="ghost" onClick={() => setTransition(null)}>Cancel</Button>
            </div>
          </div>
        )}

        {showReplacements && (
          <div className="rounded-md border border-ink-700 p-4">
            <p className="mb-3 font-semibold">Suggested replacements — the original bout is kept in history and cancelled when you create the new one.</p>
            {suggestions.loading && !suggestions.data ? (
              <p className="text-ink-400">Finding opponents…</p>
            ) : replacements.length === 0 ? (
              <p className="text-ink-400">No compatible opponents among the approved, available fighters right now. This list updates automatically as fighters are approved.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {replacements.map((x) => (
                  <SuggestionRow key={x.id} s={x} createLabel="Use as replacement" onCreate={() => setCreating(x)} onCompare={() => setComparing(x)} />
                ))}
              </ul>
            )}
          </div>
        )}
        {bout.status === 'under_review' && admin && (
          <p className="text-sm text-ink-400">To replace a fighter in a bout under review, cancel it with a reason; both fighters are then released and new opponents are suggested automatically on the Matchmaking page.</p>
        )}

        <Section title="Offers">
          {currentOffers.length === 0 ? (
            <p className="text-ink-400">No offers sent for the current terms.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {currentOffers.map((o) => {
                const r = extra.data?.responses.find((x) => x.offer_id === o.id);
                return (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-ink-850 px-3 py-2 text-sm">
                    <span>
                      <strong>{name(o.fighter_id)}</strong> <Badge tone={o.status === 'accepted' ? 'ok' : o.status === 'declined' ? 'danger' : o.status === 'pending' ? 'info' : 'neutral'}>{o.status}</Badge>
                      <span className="ml-2 text-ink-400">
                        {o.first_viewed_at ? `opened ${formatDateTime(o.first_viewed_at)}` : 'not opened'}
                        {o.responded_at && ` · answered ${formatDateTime(o.responded_at)}`}
                        {r?.decline_reason && ` · “${r.decline_reason}”`}
                        {o.revoked_reason && ` · ${o.revoked_reason}`}
                      </span>
                    </span>
                    {o.status === 'pending' && (
                      <span className="flex flex-wrap gap-2">
                        {extra.data?.links[o.id] && (
                          <>
                            <Button variant="secondary" onClick={() => void copyLink(extra.data!.links[o.id])}>Copy link</Button>
                            <a
                              className="inline-flex items-center rounded-md border border-ink-600 px-3 py-2 font-semibold hover:border-ink-400"
                              href={whatsappUrl(name(o.fighter_id) ?? 'there', bout, extra.data.links[o.id], o.expires_at)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              WhatsApp
                            </a>
                          </>
                        )}
                        <Button variant="ghost" onClick={async () => {
                          const { error } = await supabase.rpc('resend_offer_email', { p_offer: o.id });
                          done('Offer email queued (same personal link). It is delivered once email sending is set up.', error);
                        }}>Resend email</Button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {editable ? (
          <Section title="Terms">
            {bout.status === 'under_review' && bout.offer_version > 0 && <p className="mb-3 text-sm text-amber-300">Changing terms now invalidates earlier acceptances; fighters must accept again.</p>}
            <form onSubmit={saveTerms} className="grid gap-3 md:grid-cols-4">
              <Field label="Weight class">{({ id }) => (
                <Select id={id} name="weight_class_id" defaultValue={bout.weight_class_id ?? ''}>
                  <option value="">Catchweight</option>
                  {(roster.data?.classes ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}{w.division ? ` (${w.division})` : ''}</option>)}
                </Select>
              )}</Field>
              <Field label="Contracted kg">{({ id }) => <Input id={id} name="contracted" type="number" step="0.1" defaultValue={bout.contracted_weight_g ? bout.contracted_weight_g / 1000 : ''} />}</Field>
              <Field label="Rounds">{({ id }) => <Input id={id} name="rounds" type="number" min={1} max={5} defaultValue={bout.rounds} />}</Field>
              <Field label="Minutes">{({ id }) => <Input id={id} name="round_minutes" type="number" min={1} max={10} defaultValue={bout.round_minutes} />}</Field>
              <div className="md:col-span-4"><Field label="Rules">{({ id }) => <Textarea id={id} name="rules_text" defaultValue={bout.rules_text ?? ''} className="min-h-16" />}</Field></div>
              <div className="md:col-span-4"><Field label="Admin notes (internal)">{({ id }) => <Textarea id={id} name="admin_notes" defaultValue={bout.admin_notes ?? ''} className="min-h-16" />}</Field></div>
              <Button type="submit" variant="secondary" className="self-start">Save terms</Button>
            </form>
          </Section>
        ) : (
          <Section title="Admin notes">
            <form onSubmit={saveNotes} className="flex flex-col gap-2">
              <Textarea aria-label="Admin notes" name="admin_notes" defaultValue={bout.admin_notes ?? ''} className="min-h-16" />
              <p className="text-xs text-ink-400">To change terms after offers are out, move the bout to review first.</p>
              <Button type="submit" variant="secondary" className="self-start">Save notes</Button>
            </form>
          </Section>
        )}

        {bout.evaluation && (
          <Section title="Matchmaking evaluation (at creation)">
            <EvaluationDetails e={bout.evaluation} />
          </Section>
        )}

        <Section title="History">
          <ol className="flex flex-col gap-1 text-sm">
            {extra.data?.history.map((h) => (
              <li key={h.id} className="flex flex-wrap gap-2">
                <span className="text-ink-400">{formatDateTime(h.created_at)}</span>
                <span>{h.from_status ? `${BOUT_STATUS_LABELS[h.from_status]} → ` : ''}{BOUT_STATUS_LABELS[h.to_status]}</span>
                <span className="text-ink-400">by {humanize(h.actor_kind)}{h.reason ? ` — ${h.reason}` : ''}</span>
              </li>
            ))}
          </ol>
        </Section>
      </div>
      <CreateBoutModal
        eventId={bout.event_id}
        pair={creating ? [creating.fighter_a_id, creating.fighter_b_id] : null}
        evaluation={creating?.evaluation ?? null}
        suggestionId={creating?.id}
        replacesBoutId={bout.id}
        classes={roster.data?.classes ?? []}
        names={creating ? { [creating.fighter_a_id]: creating.fighter_a.fight_name, [creating.fighter_b_id]: creating.fighter_b.fight_name } : {}}
        onClose={() => setCreating(null)}
      />
      <CompareModal s={comparing} onClose={() => setComparing(null)} />
    </Modal>
  );
}
