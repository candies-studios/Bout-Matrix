import { useState } from 'react';
import { Link } from 'react-router';
import { supabase, friendlyError } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { must, useAsync } from '@/hooks/useAsync';
import { Alert, Badge, Button, EmptyState, Input, PageHeader, Select } from '@/components/ui';
import { Table } from '@/components/more';
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
  async function toggleCard(v: boolean) {
    const { error } = await supabase.rpc('set_fight_card_published', { p_event: eventId, p_published: v });
    done(v ? 'Fight card is live.' : 'Fight card hidden.', error);
  }

  return (
    <div>
      <PageHeader title="Fight cards" actions={<EventPicker eventId={eventId} setEventId={setEventId} events={events} />} />
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
                        <Select aria-label={`${b.bout_code} segment`} value={b.card_segment ?? 'main_card'} disabled={!admin} onChange={(e) => void patch(b, { card_segment: e.target.value })} className="w-40">
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
