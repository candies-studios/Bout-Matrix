import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { supabase } from '@/lib/supabase';
import { publicMediaUrl } from '@/lib/api';
import { useAsync } from '@/hooks/useAsync';
import { useSeo } from '@/hooks/useSeo';
import { formatDateTime, humanize, recordText, venueText, type RecordLike } from '@/lib/format';
import { Badge, EmptyState, Select } from '@/components/ui';
import { Loading } from '@/components/Loading';
import { ShareButtons } from '@/components/ShareButtons';
import { useEventDetail } from '@/hooks/useEventDetail';

interface PublicFighter {
  fight_name: string;
  nickname: string | null;
  country: string | null;
  hometown: string | null;
  photo_path: string | null;
  gym: string | null;
  primary_style: string | null;
  record: (RecordLike & { ko_tko_wins: number | null; submission_wins: number | null; decision_wins: number | null }) | null;
}
interface CardBout {
  bout_code: string;
  card_order: number | null;
  card_segment: string | null;
  weight_class: string | null;
  weight_limit_g: number | null;
  division: string | null;
  rounds: number;
  round_minutes: number;
  status: string;
  fighter_a: PublicFighter;
  fighter_b: PublicFighter;
}

const SEGMENTS: Record<string, string> = { main_card: 'Main card', prelims: 'Prelims', early_prelims: 'Early prelims' };

function Corner({ f, align }: { f: PublicFighter; align: 'left' | 'right' }) {
  const photo = publicMediaUrl(f.photo_path);
  return (
    <div className={`flex items-center gap-3 ${align === 'right' ? 'flex-row-reverse text-right' : ''}`}>
      {photo ? (
        <img src={photo} alt="" className="h-16 w-16 shrink-0 rounded-full border border-ink-700 object-cover sm:h-20 sm:w-20" loading="lazy" />
      ) : (
        <div aria-hidden="true" className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-ink-700 bg-ink-800 font-display text-2xl text-ink-400 sm:h-20 sm:w-20">
          {f.fight_name.slice(0, 1)}
        </div>
      )}
      <div className="min-w-0">
        <p className="font-display text-xl font-bold uppercase leading-tight sm:text-2xl">{f.fight_name}</p>
        {f.nickname && <p className="text-sm italic text-ink-400">“{f.nickname}”</p>}
        <p className="text-sm text-ink-300">{f.record ? recordText(f.record) : 'Record unverified'}</p>
        <p className="text-xs text-ink-400">{[f.gym, f.country].filter(Boolean).join(' · ')}</p>
      </div>
    </div>
  );
}

export function FightCardPage() {
  const { eventSlug } = useParams();
  const ev = useEventDetail(eventSlug);
  const [filter, setFilter] = useState('');
  const card = useAsync(async () => {
    const { data, error } = await supabase.rpc('public_get_fight_card', { p_slug: eventSlug });
    if (error) throw error;
    return data as CardBout[];
  }, [eventSlug]);
  const e = ev.data;
  useSeo(e ? `${e.name} — Fight card` : undefined, e ? `Official fight card · ${formatDateTime(e.starts_at, e.timezone)} · ${venueText(e)}` : undefined);

  const classes = useMemo(() => [...new Set((card.data ?? []).map((b) => b.weight_class).filter(Boolean))] as string[], [card.data]);
  const bouts = (card.data ?? []).filter((b) => !filter || b.weight_class === filter);
  const groups = bouts.reduce<Record<string, CardBout[]>>((acc, b) => {
    (acc[b.card_segment ?? 'main_card'] ??= []).push(b);
    return acc;
  }, {});

  return (
    <Loading loading={ev.loading || card.loading} error={ev.error || card.error}>
      {!e ? (
        <EmptyState title="Event not found" />
      ) : (
        <div>
          <Link to={`/events/${e.slug}`} className="text-sm text-ink-400 hover:text-ink-100">
            ← {e.name}
          </Link>
          <h1 className="mt-2 text-5xl font-bold uppercase">Fight card</h1>
          <p className="mt-1 text-ink-400">
            {formatDateTime(e.starts_at, e.timezone)} · {venueText(e)}
          </p>
          {!e.fight_card_published || bouts.length === 0 ? (
            <div className="mt-8">
              <EmptyState title={filter ? 'No bouts in this weight class' : 'Fight card coming soon'}>
                {filter ? null : 'Bouts appear here once they are confirmed and announced.'}
              </EmptyState>
            </div>
          ) : (
            <>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                {classes.length > 1 && (
                  <label className="flex items-center gap-2 text-sm text-ink-400">
                    Weight class
                    <Select value={filter} onChange={(x) => setFilter(x.target.value)} className="w-auto">
                      <option value="">All</option>
                      {classes.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </Select>
                  </label>
                )}
                <ShareButtons url={window.location.href} text={`${e.name} fight card`} />
              </div>
              {Object.entries(SEGMENTS)
                .filter(([k]) => groups[k]?.length)
                .map(([k, label]) => (
                  <section key={k} className="mt-8">
                    <h2 className="border-b border-accent-600 pb-2 text-2xl font-bold uppercase">{label}</h2>
                    <ol className="mt-4 flex flex-col gap-3">
                      {groups[k].map((b, i) => (
                        <li key={b.bout_code} className="rounded-lg border border-ink-700 bg-ink-900 p-4">
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs uppercase tracking-wide text-ink-400">
                            <span>
                              Bout {b.card_order ?? i + 1} · {b.weight_class ?? 'Catchweight'}
                              {b.division ? ` · ${humanize(b.division)}` : ''}
                            </span>
                            <span className="flex items-center gap-2">
                              {b.rounds} × {b.round_minutes} min
                              <Badge tone={b.status === 'completed' ? 'neutral' : 'ok'}>{b.status === 'completed' ? 'Completed' : 'Confirmed'}</Badge>
                            </span>
                          </div>
                          <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                            <Corner f={b.fighter_a} align="left" />
                            <span className="text-center font-display text-2xl font-bold text-accent-500">VS</span>
                            <Corner f={b.fighter_b} align="right" />
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
            </>
          )}
        </div>
      )}
    </Loading>
  );
}
