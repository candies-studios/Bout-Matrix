import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { must, useAsync } from '@/hooks/useAsync';
import { formatDateTime, humanize } from '@/lib/format';
import { EmptyState, PageHeader, Select } from '@/components/ui';
import { Pagination, Table } from '@/components/more';
import { Loading } from '@/components/Loading';

const PAGE = 50;
const TABLES = ['bouts', 'bout_offers', 'events', 'event_registrations', 'fighters', 'fighter_private', 'fighter_records', 'coaches', 'coach_fighters', 'gyms', 'user_roles', 'event_admins', 'weight_classes', 'matchmaking_rules', 'organizations', 'system_settings'];
interface Log { id: number; actor_id: string | null; actor_kind: string; action: string; table_name: string; record_id: string; changes: Record<string, unknown>; reason: string | null; created_at: string }

export function AuditLogs() {
  const [table, setTable] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const q = useAsync(async () => {
    let query = supabase.from('audit_logs').select('*', { count: 'exact' }).order('id', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (table) query = query.eq('table_name', table);
    const r = await query;
    const rows = must(r) as Log[];
    const ids = [...new Set(rows.map((x) => x.actor_id).filter(Boolean))] as string[];
    const users = ids.length ? (must(await supabase.from('user_profiles').select('id, email').in('id', ids)) as { id: string; email: string }[]) : [];
    return { rows, count: r.count ?? 0, users: Object.fromEntries(users.map((u) => [u.id, u.email])) };
  }, [table, page]);
  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Append-only. Entries cannot be edited or deleted. Personal data values are redacted."
        actions={
          <Select aria-label="Table" value={table} onChange={(e) => { setTable(e.target.value); setPage(0); }}>
            <option value="">All records</option>
            {TABLES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
          </Select>
        }
      />
      <Loading loading={q.loading} error={q.error}>
        {q.data?.rows.length ? (
          <>
            <Table caption="Audit log">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Record</th><th>Reason</th><th>Changes</th></tr></thead>
              <tbody>
                {q.data.rows.map((l) => (
                  <tr key={l.id} className="align-top">
                    <td className="whitespace-nowrap">{formatDateTime(l.created_at)}</td>
                    <td>{l.actor_id ? q.data!.users[l.actor_id] ?? l.actor_id.slice(0, 8) : humanize(l.actor_kind)}</td>
                    <td>{l.action}</td>
                    <td>{humanize(l.table_name)}<div className="text-xs text-ink-400">{l.record_id?.slice(0, 8)}</div></td>
                    <td className="max-w-xs">{l.reason ?? '—'}</td>
                    <td>
                      <button className="text-sm underline" onClick={() => setOpen(open === l.id ? null : l.id)}>{Object.keys(l.changes ?? {}).length} field(s)</button>
                      {open === l.id && <pre className="mt-2 max-w-md overflow-auto whitespace-pre-wrap rounded bg-ink-850 p-2 text-xs">{JSON.stringify(l.changes, null, 2)}</pre>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE} total={q.data.count} onPage={setPage} />
          </>
        ) : (
          <EmptyState title="No audit entries" />
        )}
      </Loading>
    </div>
  );
}
