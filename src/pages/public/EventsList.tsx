import { useState } from 'react';
import { Link } from 'react-router';
import { supabase } from '@/lib/supabase';
import { useAsync } from '@/hooks/useAsync';
import { useSeo } from '@/hooks/useSeo';
import { formatDateTime, venueText } from '@/lib/format';
import { Badge, EmptyState, PageHeader } from '@/components/ui';
import { Tabs } from '@/components/more';
import { Loading } from '@/components/Loading';

export interface PublicEvent {
  slug: string;
  name: string;
  promotion: string | null;
  description: string | null;
  starts_at: string | null;
  timezone: string;
  venue_name: string | null;
  venue_city: string | null;
  venue_country: string | null;
  status: string;
  registration_open: boolean;
  fight_card_published: boolean;
}

export function EventsList() {
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming');
  useSeo('Events', 'Upcoming and past fight nights.');
  const q = useAsync(async () => {
    const { data, error } = await supabase.rpc('public_list_events', { p_scope: scope });
    if (error) throw error;
    return data as PublicEvent[];
  }, [scope]);

  return (
    <div>
      <PageHeader title="Events" />
      <Tabs value={scope} onChange={setScope} options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }]} />
      <Loading loading={q.loading} error={q.error}>
        {q.data?.length ? (
          <ul className="grid gap-4 md:grid-cols-2">
            {q.data.map((e) => (
              <li key={e.slug}>
                <Link to={`/events/${e.slug}`} className="block h-full rounded-lg border border-ink-700 bg-ink-900 p-5 hover:border-accent-600">
                  <div className="flex flex-wrap gap-2">
                    {e.status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
                    {e.registration_open && <Badge tone="ok">Registration open</Badge>}
                    {e.fight_card_published && <Badge tone="info">Fight card</Badge>}
                  </div>
                  <h2 className="mt-3 text-3xl font-bold uppercase">{e.name}</h2>
                  {e.promotion && <p className="text-sm text-ink-400">{e.promotion}</p>}
                  <p className="mt-3 text-ink-300">{formatDateTime(e.starts_at, e.timezone)}</p>
                  <p className="text-ink-400">{venueText(e)}</p>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={scope === 'upcoming' ? 'No upcoming events yet' : 'No past events'} />
        )}
      </Loading>
    </div>
  );
}
