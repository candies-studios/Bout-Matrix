import { Link } from 'react-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { isOrgAdmin } from '@/lib/access';
import { must, useAsync } from '@/hooks/useAsync';
import { formatDate, humanize } from '@/lib/format';
import { Badge, Card, PageHeader } from '@/components/ui';
import { Loading } from '@/components/Loading';

interface Overview {
  fighters: number;
  coaches: number;
  gyms: number;
  active_events: number;
  pending_registrations: number;
  fighters_by_weight_class: { name: string; division: string | null; n: number }[];
  open_suggestions: number;
  outstanding_offers: number;
  accepted_offers: number;
  declined_offers: number;
  confirmed_bouts: number;
  email_failures: number;
  upcoming_events: { id: string; name: string; slug: string; starts_at: string | null; status: string }[];
}

function Stat({ label, value, to, tone }: { label: string; value: number; to: string; tone?: 'warn' | 'danger' }) {
  return (
    <Link to={to} className="rounded-lg border border-ink-700 bg-ink-900 p-4 hover:border-ink-400">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</p>
      <p className={`mt-1 font-display text-4xl font-bold ${tone === 'danger' && value ? 'text-accent-400' : tone === 'warn' && value ? 'text-amber-300' : ''}`}>{value}</p>
    </Link>
  );
}

export function Dashboard() {
  const { access, session } = useAuth();
  const q = useAsync(async () => must(await supabase.rpc('admin_overview_fresh')) as Overview, []);
  const o = q.data;
  return (
    <div>
      <PageHeader title="Dashboard" description={`Signed in as ${session?.user.email ?? ''}${isOrgAdmin(access) ? ' · organisation admin' : ''}`} />
      <Loading loading={q.loading} error={q.error}>
        {o && (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
              <Stat label="Fighters" value={o.fighters} to="/admin/fighters" />
              <Stat label="Coaches" value={o.coaches} to="/admin/coaches" />
              <Stat label="Gyms" value={o.gyms} to="/admin/gyms" />
              <Stat label="Active events" value={o.active_events} to="/admin/events" />
              <Stat label="Pending registrations" value={o.pending_registrations} to="/admin/fighters?status=pending" tone="warn" />
              <Stat label="Suggested matchups" value={o.open_suggestions} to="/admin/matchmaking" />
              <Stat label="Outstanding offers" value={o.outstanding_offers} to="/admin/bouts" />
              <Stat label="Accepted (to confirm)" value={o.accepted_offers} to="/admin/bouts" tone="warn" />
              <Stat label="Declined / expired" value={o.declined_offers} to="/admin/bouts" tone="warn" />
              <Stat label="Confirmed bouts" value={o.confirmed_bouts} to="/admin/fight-cards" />
              <Stat label="Email failures" value={o.email_failures} to="/admin/emails?status=failed" tone="danger" />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <h2 className="mb-3 text-xl font-semibold uppercase">Upcoming events</h2>
                {o.upcoming_events.length === 0 ? (
                  <p className="text-ink-400">No upcoming events.</p>
                ) : (
                  <ul className="divide-y divide-ink-700">
                    {o.upcoming_events.map((e) => (
                      <li key={e.id} className="flex items-center justify-between py-2">
                        <Link to={`/admin/events/${e.id}`} className="font-semibold hover:underline">
                          {e.name}
                        </Link>
                        <span className="flex items-center gap-2 text-sm text-ink-400">
                          {formatDate(e.starts_at)} <Badge>{humanize(e.status)}</Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card>
                <h2 className="mb-3 text-xl font-semibold uppercase">Approved fighters by weight class</h2>
                {o.fighters_by_weight_class.length === 0 ? (
                  <p className="text-ink-400">No approved registrations with a preferred class yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {o.fighters_by_weight_class.map((w) => {
                      const max = Math.max(...o.fighters_by_weight_class.map((x) => x.n));
                      return (
                        <li key={`${w.name}-${w.division}`} className="grid grid-cols-[10rem_1fr_2rem] items-center gap-3 text-sm">
                          <span className="truncate">
                            {w.name} <span className="text-ink-400">{w.division ? humanize(w.division) : ''}</span>
                          </span>
                          <span className="h-2 rounded bg-ink-800">
                            <span className="block h-2 rounded bg-accent-600" style={{ width: `${(w.n / max) * 100}%` }} />
                          </span>
                          <span className="text-right">{w.n}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        )}
      </Loading>
    </div>
  );
}
