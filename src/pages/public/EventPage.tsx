import { Link, useParams } from 'react-router';
import { useEventDetail } from '@/hooks/useEventDetail';
import { useSeo } from '@/hooks/useSeo';
import { formatDateTime, venueText } from '@/lib/format';
import { Badge, Card, EmptyState } from '@/components/ui';
import { Loading } from '@/components/Loading';
import { ShareButtons } from '@/components/ShareButtons';

export function EventPage() {
  const { eventSlug } = useParams();
  const q = useEventDetail(eventSlug);
  const e = q.data;
  useSeo(e?.name, e ? `${formatDateTime(e.starts_at, e.timezone)} · ${venueText(e)}` : undefined);

  return (
    <Loading loading={q.loading} error={q.error}>
      {!e ? (
        <EmptyState title="Event not found">This event does not exist or is not public yet.</EmptyState>
      ) : (
        <article>
          <div className="flex flex-wrap gap-2">
            {e.status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
            {e.status === 'completed' && <Badge>Completed</Badge>}
            {e.registration_open && <Badge tone="ok">Registration open</Badge>}
          </div>
          <h1 className="mt-3 text-5xl font-bold uppercase leading-none">{e.name}</h1>
          {e.promotion && <p className="mt-2 text-ink-400">{e.promotion}</p>}
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-400">Date</p>
              <p className="mt-1 text-lg">{formatDateTime(e.starts_at, e.timezone)}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-400">Venue</p>
              <p className="mt-1 text-lg">{venueText(e)}</p>
              {e.venue_address && <p className="text-sm text-ink-400">{e.venue_address}</p>}
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-400">Fight card</p>
              <Link to={`/events/${e.slug}/fight-card`} className="mt-1 inline-block text-lg font-semibold text-accent-400 hover:underline">
                {e.fight_card_published ? 'View fight card →' : 'Coming soon'}
              </Link>
            </Card>
          </div>
          {e.registration_open && (
            <Card className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-display text-2xl font-bold uppercase">Want to compete?</p>
                {e.registration_closes_at && <p className="text-sm text-ink-400">Registration closes {formatDateTime(e.registration_closes_at, e.timezone)}</p>}
              </div>
              <div className="flex gap-2">
                <Link to={`/register/fighter?event=${e.slug}`} className="inline-flex min-h-11 items-center rounded-md bg-accent-600 px-4 font-semibold text-white hover:bg-accent-500">
                  Register as a fighter
                </Link>
                <Link to={`/register/coach?event=${e.slug}`} className="inline-flex min-h-11 items-center rounded-md border border-ink-700 bg-ink-800 px-4 font-semibold hover:bg-ink-700">
                  Coach / gym
                </Link>
              </div>
            </Card>
          )}
          {e.description && <p className="mt-8 max-w-3xl whitespace-pre-line text-ink-300">{e.description}</p>}
          {e.weight_classes.length > 0 && (
            <section className="mt-8">
              <h2 className="text-2xl font-bold uppercase">Weight classes</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {e.weight_classes.map((w) => (
                  <li key={w.id} className="rounded border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm">
                    {w.name}
                    {w.division ? ` · ${w.division}` : ''} · {(w.max_g / 1000).toFixed(1)} kg
                  </li>
                ))}
              </ul>
            </section>
          )}
          {e.rules_text && (
            <section className="mt-8">
              <h2 className="text-2xl font-bold uppercase">Rules</h2>
              <p className="mt-2 max-w-3xl whitespace-pre-line text-ink-300">{e.rules_text}</p>
            </section>
          )}
          <div className="mt-8">
            <ShareButtons url={window.location.href} text={e.name} />
          </div>
        </article>
      )}
    </Loading>
  );
}
