import { useState } from 'react';
import { Link } from 'react-router';
import { supabase, friendlyError } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { must, useAsync } from '@/hooks/useAsync';
import { Alert, Badge, Button, EmptyState, Input, PageHeader, Select } from '@/components/ui';
import { Section, Table } from '@/components/more';
import { ExportBouts } from '@/components/ExportBouts';
import { EventPicker } from '@/components/EventPicker';
import { useSelectedEvent } from '@/hooks/useSelectedEvent';
import { Loading } from '@/components/Loading';
import { BoutStatusBadge } from '@/components/StatusBadge';
import { BOUT_SELECT, canManageEvent, type BoutRow } from '@/lib/bouts';

export function FightCards() {
  const { access } = useAuth();
  const { eventId, setEventId, events } = useSelectedEvent();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const q = useAsync(async () => {
    if (!eventId) return null;
    const event = must(await supabase.from('events').select('id, slug, name, is_public, fight_card_published, status').eq('id', eventId).single()) as { id: string; slug: string; name: string; is_public: boolean; fight_card_published: boolean; status: string };
    const bouts = must(await supabase.from('bouts').select(BOUT_SELECT).eq('event_id', eventId).in('status', ['confirmed', 'completed']).order('card_order', { ascending: true, nullsFirst: false })) as unknown as BoutRow[];
    const p = await supabase.from('bouts').select('id', { count: 'exact', head: true }).eq('event_id', eventId).in('status', ['offer_sent', 'awaiting_responses', 'accepted_one', 'accepted_both', 'under_review']);
    if (p.error) throw p.error;
    return { event, bouts, pending: p.count ?? 0 };
  }, [eventId]);
  const admin = canManageEvent(access, eventId);
  const done = (text: string, error?: unknown) => {
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text });
    void q.reload();
  };

  async function publishBout(b: BoutRow, v: boolean) {
    const { error } = await supabase.rpc('set_bout_published', { p_bout: b.id, p_published: v });
    done(v ? `${b.bout_code} published.` : `${b.bout_code} unpublished.`, error);
  }
  async function patch(b: BoutRow, values: Record<string, unknown>) {
    const { error } = await supabase.from('bouts').update(values).eq('id', b.id);
    if (error) done('', /duplicate|unique/.test(error.message) ? new Error('Another bout already has that position. Use “Renumber” or pick a free number.') : error);
    else void q.reload();
  }
  async function renumber() {
    const bouts = q.data?.bouts ?? [];
    for (const b of bouts) {
      const { error } = await supabase.from('bouts').update({ card_order: null }).eq('id', b.id);
      if (error) return done('', error);
    }
    const ordered = [...bouts].sort((a, b) => (a.card_order ?? 999) - (b.card_order ?? 999));
    for (const [i, b] of ordered.entries()) {
      const { error } = await supabase.from('bouts').update({ card_order: i + 1 }).eq('id', b.id);
      if (error) return done('', error);
    }
    done('Bouts renumbered 1…n.');
  }
  async function move(b: BoutRow, dir: -1 | 1) {
    const list = q.data?.bouts ?? [];
    const idx = list.findIndex((x) => x.id === b.id);
    const other = list[idx + dir];
    if (!other) return;
    const [x, y] = [b.card_order ?? idx + 1, other.card_order ?? idx + 1 + dir];
    await supabase.from('bouts').update({ card_order: null }).eq('id', b.id);
    await supabase.from('bouts').update({ card_order: x }).eq('id', other.id);
    await patch(b, { card_order: y });
  }
  // ---- handpicked main card ----
  const all = q.data?.bouts ?? [];
  const mainCard = all.filter((b) => b.card_segment === 'main_card').sort((a, b) => (a.card_order ?? 999) - (b.card_order ?? 999));
  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const classes = [...new Set(all.map((b) => b.weight_classes?.name ?? 'Catchweight'))].sort();
  const candidates = all.filter((b) => b.card_segment !== 'main_card'
    && (!classFilter || (b.weight_classes?.name ?? 'Catchweight') === classFilter)
    && (!search.trim() || `${b.fighter_a?.fight_name} ${b.fighter_b?.fight_name} ${b.fighter_a?.fighter_code} ${b.fighter_b?.fighter_code} ${b.bout_code}`.toLowerCase().includes(search.trim().toLowerCase())));
  async function saveMainCard(ids: string[], text: string) {
    const { error } = await supabase.rpc('set_main_card', { p_event: eventId, p_bouts: ids });
    done(text, error);
  }
  const ids = mainCard.map((b) => b.id);
  const label = (i: number) => (i === 0 ? 'Main event' : i === 1 ? 'Co-main event' : `Main card bout ${i + 1}`);

  async function toggleCard(v: boolean) {
    const { error } = await supabase.rpc('set_fight_card_published', { p_event: eventId, p_published: v });
    done(v ? 'Fight card is live.' : 'Fight card hidden.', error);
  }

  return (
    <div>
      <PageHeader
        title="Fight cards"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {admin && q.data && <ExportBouts eventId={q.data.event.id} eventName={q.data.event.name} />}
            <EventPicker eventId={eventId} setEventId={setEventId} events={events} />
          </div>
        }
      />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      <Loading loading={q.loading} error={q.error}>
        {q.data && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-700 bg-ink-900 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{q.data.event.name}</span>
                {q.data.event.fight_card_published ? <Badge tone="ok">Card live</Badge> : <Badge>Card hidden</Badge>}
                {!q.data.event.is_public && <Badge tone="warn">Event page hidden</Badge>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to={`/events/${q.data.event.slug}/fight-card`} target="_blank" className="inline-flex min-h-11 items-center rounded-md border border-ink-700 px-4 text-sm font-semibold hover:bg-ink-800">Preview public card ↗</Link>
                {admin && <Button variant="secondary" onClick={() => void renumber()}>Renumber</Button>}
                {admin && (q.data.event.fight_card_published
                  ? <Button variant="danger" onClick={() => void toggleCard(false)}>Unpublish card</Button>
                  : <Button onClick={() => void toggleCard(true)} disabled={!q.data.event.is_public}>Publish card</Button>)}
              </div>
            </div>
            {!q.data.event.is_public && <Alert tone="info">Make the event public (Events → Details) before publishing its fight card.</Alert>}
            {q.data.pending > 0 && <Alert tone="info">{q.data.pending} bout(s) are still in the offer or review stage and are not shown here.</Alert>}
            <p className="text-sm text-ink-400">Only confirmed bouts appear here, and only bouts you publish appear on the public card. Drafts, pending, declined and expired bouts are never public.</p>
            {q.data.bouts.length > 0 && admin && (
              <Section title={`Main card (${mainCard.length})`}>
                <p className="mb-3 text-sm text-ink-400">Handpick the bouts for the main card. The first is the main event, the second the co-main event. Every other confirmed bout goes on the prelims, numbered after the main card.</p>
                {mainCard.length === 0 ? (
                  <p className="rounded-md border border-dashed border-ink-700 p-4 text-ink-400">No bouts picked yet — use “Add to main card” below.</p>
                ) : (
                  <ol className="flex flex-col gap-2">
                    {mainCard.map((b, i) => (
                      <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ink-850 px-3 py-2">
                        <span>
                          <span className={`mr-2 text-xs font-semibold uppercase ${i < 2 ? 'text-accent-400' : 'text-ink-400'}`}>{label(i)}</span>
                          <span className="font-semibold">{b.fighter_a?.fight_name} vs {b.fighter_b?.fight_name}</span>
                          <span className="ml-2 text-xs text-ink-400">{b.bout_code} · {b.weight_classes?.name ?? 'Catchweight'}</span>
                        </span>
                        <span className="flex gap-1">
                          <Button variant="ghost" aria-label={`Move ${b.bout_code} up`} disabled={i === 0}
                                  onClick={() => void saveMainCard(ids.map((x, j) => (j === i - 1 ? b.id : j === i ? ids[i - 1] : x)), 'Main card order saved.')}>↑</Button>
                          <Button variant="ghost" aria-label={`Move ${b.bout_code} down`} disabled={i === mainCard.length - 1}
                                  onClick={() => void saveMainCard(ids.map((x, j) => (j === i + 1 ? b.id : j === i ? ids[i + 1] : x)), 'Main card order saved.')}>↓</Button>
                          <Button variant="secondary" onClick={() => void saveMainCard(ids.filter((x) => x !== b.id), `${b.bout_code} moved to the prelims.`)}>Remove</Button>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="mt-5 border-t border-ink-700 pt-4">
                  <p className="mb-2 font-semibold">Add to the main card</p>
                  <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_14rem]">
                    <Input aria-label="Search bouts" placeholder="Search fighter name, fighter ID or bout ID" value={search} onChange={(e) => setSearch(e.target.value)} />
                    <Select aria-label="Weight class filter" value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
                      <option value="">All weight classes</option>
                      {classes.map((c) => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  </div>
                  {candidates.length === 0 ? (
                    <p className="text-sm text-ink-400">No other confirmed bouts match.</p>
                  ) : (
                    <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto">
                      {candidates.map((b) => (
                        <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-700 px-3 py-2">
                          <span>
                            <span className="font-semibold">{b.fighter_a?.fight_name} vs {b.fighter_b?.fight_name}</span>
                            <span className="ml-2 text-xs text-ink-400">{b.bout_code} · {b.weight_classes?.name ?? 'Catchweight'} · {b.rounds}×{b.round_minutes}</span>
                          </span>
                          <Button onClick={() => void saveMainCard([...ids, b.id], `${b.bout_code} added to the main card.`)}>Add to main card</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Section>
            )}
            {q.data.bouts.length === 0 ? (
              <EmptyState title="No confirmed bouts yet" />
            ) : (
              <Table caption="Confirmed bouts">
                <thead><tr><th>Order</th><th>Bout</th><th>Segment</th><th>Status</th><th>Public</th></tr></thead>
                <tbody>
                  {q.data.bouts.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <div className="flex items-center gap-1">
                          <Input aria-label={`${b.bout_code} order`} type="number" min={1} max={99} defaultValue={b.card_order ?? ''} disabled={!admin} className="w-20" onBlur={(e) => e.target.value && Number(e.target.value) !== b.card_order && void patch(b, { card_order: Number(e.target.value) })} />
                          {admin && (
                            <>
                              <Button variant="ghost" aria-label="Move up" onClick={() => void move(b, -1)}>↑</Button>
                              <Button variant="ghost" aria-label="Move down" onClick={() => void move(b, 1)}>↓</Button>
                            </>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="font-semibold">{b.fighter_a?.fight_name} vs {b.fighter_b?.fight_name}</span>
                        <div className="text-xs text-ink-400">{b.bout_code} · {b.weight_classes?.name ?? 'Catchweight'} · {b.rounds}×{b.round_minutes}</div>
                      </td>
                      <td>
                        <Select aria-label={`${b.bout_code} segment`} value={b.card_segment ?? 'prelims'} disabled={!admin} onChange={(e) => void patch(b, { card_segment: e.target.value })} className="w-40">
                          <option value="main_card">Main card</option>
                          <option value="prelims">Prelims</option>
                          <option value="early_prelims">Early prelims</option>
                        </Select>
                      </td>
                      <td><BoutStatusBadge status={b.status} /></td>
                      <td>
                        {admin ? (
                          <Button variant={b.is_published ? 'secondary' : 'primary'} onClick={() => void publishBout(b, !b.is_published)}>{b.is_published ? 'Unpublish' : 'Publish'}</Button>
                        ) : b.is_published ? 'Yes' : 'No'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        )}
      </Loading>
    </div>
  );
}
