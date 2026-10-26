import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { supabase, friendlyError } from '@/lib/supabase';
import { must, useAsync } from '@/hooks/useAsync';
import { formatDateTime, humanize } from '@/lib/format';
import { Alert, Badge, Button, EmptyState, PageHeader, Select, type Tone } from '@/components/ui';
import { Pagination, Table } from '@/components/more';
import { Loading } from '@/components/Loading';

const PAGE = 50;
const TONE: Record<string, Tone> = { queued: 'info', sending: 'info', sent: 'ok', failed: 'danger', cancelled: 'neutral' };
interface Mail { id: string; template: string; to_email: string; status: string; attempts: number; max_attempts: number; last_error: string | null; delivery_status: string | null; provider_message_id: string | null; created_at: string; sent_at: string | null; next_attempt_at: string }

export function Emails() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 0);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const q = useAsync(async () => {
    let query = supabase.from('email_logs').select('id, template, to_email, status, attempts, max_attempts, last_error, delivery_status, provider_message_id, created_at, sent_at, next_attempt_at', { count: 'exact' }).order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (status) query = query.eq('status', status);
    const r = await query;
    return { rows: must(r) as Mail[], count: r.count ?? 0 };
  }, [status, page]);
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'page') n.delete('page');
    setParams(n);
  };
  async function act(fn: 'retry_email' | 'resend_email', id: string) {
    const { error } = await supabase.rpc(fn, { p_id: id });
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text: fn === 'retry_email' ? 'Queued for another attempt.' : 'A new copy was queued.' });
    void q.reload();
  }
  return (
    <div>
      <PageHeader
        title="Emails"
        description="“Sent” means the email provider accepted the message. Delivery, bounces and complaints are reported separately."
        actions={
          <Select aria-label="Status" value={status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All statuses</option>
            {['queued', 'sending', 'sent', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </Select>
        }
      />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      <Loading loading={q.loading} error={q.error}>
        {q.data?.rows.length ? (
          <>
            <Table caption="Email log">
              <thead><tr><th>Created</th><th>Template</th><th>Recipient</th><th>Status</th><th>Delivery</th><th>Attempts</th><th /></tr></thead>
              <tbody>
                {q.data.rows.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap">{formatDateTime(m.created_at)}</td>
                    <td>{humanize(m.template)}</td>
                    <td>{m.to_email}</td>
                    <td>
                      <Badge tone={TONE[m.status]}>{m.status}</Badge>
                      {m.last_error && <div className="mt-1 max-w-xs text-xs text-accent-400">{m.last_error}</div>}
                      {m.status === 'queued' && m.attempts > 0 && <div className="text-xs text-ink-400">Next try {formatDateTime(m.next_attempt_at)}</div>}
                    </td>
                    <td>{m.delivery_status ? <Badge tone={m.delivery_status === 'delivered' ? 'ok' : 'warn'}>{m.delivery_status}</Badge> : '—'}</td>
                    <td>{m.attempts}/{m.max_attempts}</td>
                    <td>
                      {(m.status === 'failed' || m.status === 'cancelled') && <Button variant="secondary" onClick={() => void act('retry_email', m.id)}>Retry</Button>}
                      {m.status === 'sent' && m.template !== 'bout_offer' && <Button variant="ghost" onClick={() => void act('resend_email', m.id)}>Resend</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE} total={q.data.count} onPage={(p) => set('page', String(p))} />
          </>
        ) : (
          <EmptyState title="No emails" />
        )}
      </Loading>
    </div>
  );
}
