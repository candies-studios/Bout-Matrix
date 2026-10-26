import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { supabase } from '@/lib/supabase';
import { must, useAsync } from '@/hooks/useAsync';
import { useAdminEvents } from '@/hooks/useEvents';
import { downloadText, formatDate, formatWeight, humanize, toCsv } from '@/lib/format';
import { Button, EmptyState, Input, PageHeader, Select } from '@/components/ui';
import { Pagination, Table } from '@/components/more';
import { Loading } from '@/components/Loading';
import { RegistrationStatusBadge, type RegistrationStatus } from '@/components/StatusBadge';

const PAGE = 25;
const STATUS_FILTERS: Record<string, RegistrationStatus[]> = {
  pending: ['submitted', 'under_review', 'incomplete'],
  approved: ['approved'],
  rejected: ['rejected'],
};

interface Row {
  id: string;
  fighter_code: string;
  fight_name: string;
  division: string;
  status: string;
  registered_at: string;
  gyms: { name: string } | null;
  fighter_private: { legal_name: string; email: string } | null;
  event_registrations: { id: string; status: RegistrationStatus; event_id: string; declared_weight_g: number | null }[];
}

/** Escape characters with meaning in PostgREST filter syntax. */
const clean = (s: string) => s.replace(/[%,()*\\]/g, ' ').trim();

export function FightersAdmin() {
  const [params, setParams] = useSearchParams();
  const events = useAdminEvents();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const eventId = params.get('event') ?? '';
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 0);
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'page') n.delete('page');
    setParams(n);
  };

  const query = (forExport = false) => {
    const filtered = Boolean(eventId || status);
    let q = supabase
      .from('fighters')
      .select(
        `id, fighter_code, fight_name, division, status, registered_at, gyms(name), fighter_private(legal_name, email),
         event_registrations${filtered ? '!inner' : ''}(id, status, event_id, declared_weight_g)`,
        { count: 'exact' },
      )
      .neq('status', 'merged')
      .order('registered_at', { ascending: false });
    if (eventId) q = q.eq('event_registrations.event_id', eventId);
    if (status) q = q.in('event_registrations.status', STATUS_FILTERS[status] ?? [status]);
    const s = clean(params.get('q') ?? '');
    if (s) q = q.or(`fight_name.ilike.%${s}%,fighter_code.ilike.%${s}%`);
    return forExport ? q.limit(5000) : q.range(page * PAGE, page * PAGE + PAGE - 1);
  };

  const q = useAsync(async () => {
    const r = await query();
    return { rows: must(r) as unknown as Row[], count: r.count ?? 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.toString()]);

  async function exportCsv() {
    const rows = must(await query(true)) as unknown as Row[];
    downloadText(
      `fighters-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        rows.map((r) => ({
          fighter_id: r.fighter_code,
          fight_name: r.fight_name,
          legal_name: r.fighter_private?.legal_name,
          email: r.fighter_private?.email,
          division: r.division,
          gym: r.gyms?.name,
          registrations: r.event_registrations.map((x) => `${events.data?.find((e) => e.id === x.event_id)?.name ?? x.event_id}:${x.status}`).join('; '),
          registered_at: r.registered_at,
        })),
      ),
    );
  }

  return (
    <div>
      <PageHeader title="Fighters" actions={<Button variant="secondary" onClick={() => void exportCsv()}>Export CSV</Button>} />
      <div className="mb-4 grid gap-3 md:grid-cols-[1fr_16rem_12rem]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParam('q', search);
          }}
        >
          <Input aria-label="Search fighters" type="search" placeholder="Search by fight name or fighter ID" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
        <Select aria-label="Event" value={eventId} onChange={(e) => setParam('event', e.target.value)}>
          <option value="">All events</option>
          {(events.data ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Registration status" value={status} onChange={(e) => setParam('status', e.target.value)}>
          <option value="">Any status</option>
          <option value="pending">Pending review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </Select>
      </div>
      <Loading loading={q.loading} error={q.error}>
        {q.data?.rows.length ? (
          <>
            <Table caption="Fighters">
              <thead>
                <tr>
                  <th>Fighter</th>
                  <th>Legal name / email</th>
                  <th>Division</th>
                  <th>Gym</th>
                  <th>Registrations</th>
                  <th>Registered</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/admin/fighters/${r.id}`} className="font-semibold hover:underline">
                        {r.fight_name}
                      </Link>
                      <div className="text-xs text-ink-400">{r.fighter_code}</div>
                    </td>
                    <td>
                      {r.fighter_private?.legal_name}
                      <div className="text-xs text-ink-400">{r.fighter_private?.email}</div>
                    </td>
                    <td>{humanize(r.division)}</td>
                    <td>{r.gyms?.name ?? '—'}</td>
                    <td>
                      <div className="flex flex-col gap-1">
                        {r.event_registrations.map((x) => (
                          <span key={x.id} className="flex items-center gap-2 text-xs">
                            <RegistrationStatusBadge status={x.status} />
                            <span className="text-ink-400">
                              {events.data?.find((e) => e.id === x.event_id)?.name ?? 'Event'} · {formatWeight(x.declared_weight_g)}
                            </span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{formatDate(r.registered_at)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE} total={q.data.count} onPage={(p) => setParam('page', String(p))} />
          </>
        ) : (
          <EmptyState title="No fighters found" />
        )}
      </Loading>
    </div>
  );
}
