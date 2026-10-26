import { useState } from 'react';
import { supabase, friendlyError } from '@/lib/supabase';
import { callFunction } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isOrgAdmin } from '@/lib/access';
import { must, useAsync } from '@/hooks/useAsync';
import { formatDate } from '@/lib/format';
import { Alert, Badge, Button, EmptyState, PageHeader, Select, Textarea } from '@/components/ui';
import { KeyValue, Modal, Table } from '@/components/more';
import { Loading } from '@/components/Loading';

interface Coach {
  id: string; full_name: string; email: string; phone_country_code: string | null; phone: string | null; city: string | null; country: string | null;
  coaching_experience_years: number | null; experience_summary: string | null; verification_info: string | null; declared_roster: string[];
  verification_status: 'pending' | 'verified' | 'rejected'; verification_notes: string | null; user_id: string | null; created_at: string;
  gyms: { name: string } | null;
  coach_fighters: { id: string; status: string; fighter_id: string; fighters: { fight_name: string; fighter_code: string } | null }[];
}

export function CoachesAdmin() {
  const { access } = useAuth();
  const [filter, setFilter] = useState('pending');
  const [open, setOpen] = useState<Coach | null>(null);
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const q = useAsync(async () => {
    let query = supabase.from('coaches').select('*, gyms(name), coach_fighters(id, status, fighter_id, fighters(fight_name, fighter_code))').order('created_at', { ascending: false });
    if (filter) query = query.eq('verification_status', filter);
    return must(await query) as unknown as Coach[];
  }, [filter]);
  const admin = isOrgAdmin(access);

  async function verify(c: Coach, status: 'verified' | 'rejected') {
    const { error } = await supabase.rpc('verify_coach', { p_coach: c.id, p_status: status, p_notes: notes || null });
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text: `${c.full_name} ${status}. They have been emailed.` });
    setOpen(null);
    setNotes('');
    void q.reload();
  }
  async function invite(c: Coach) {
    try {
      await callFunction('invite-coach', { coach_id: c.id });
      setMsg({ tone: 'ok', text: `Invitation sent to ${c.email}.` });
      void q.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  }
  async function link(id: string, status: 'approved' | 'rejected') {
    const { error } = await supabase.from('coach_fighters').update({ status }).eq('id', id);
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text: `Roster link ${status}.` });
    void q.reload();
    setOpen(null);
  }

  return (
    <div>
      <PageHeader
        title="Coaches"
        actions={
          <Select aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="pending">Pending verification</option>
            <option value="verified">Verified</option>
            <option value="rejected">Rejected</option>
            <option value="">All</option>
          </Select>
        }
      />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      <Loading loading={q.loading} error={q.error}>
        {q.data?.length ? (
          <Table caption="Coaches">
            <thead><tr><th>Coach</th><th>Gym</th><th>Experience</th><th>Roster</th><th>Status</th><th>Account</th></tr></thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <button className="font-semibold hover:underline" onClick={() => setOpen(c)}>{c.full_name}</button>
                    <div className="text-xs text-ink-400">{c.email}</div>
                  </td>
                  <td>{c.gyms?.name ?? '—'}</td>
                  <td>{c.coaching_experience_years ?? '—'} yrs</td>
                  <td>{c.coach_fighters.filter((x) => x.status === 'approved').length} linked · {c.declared_roster.length} declared</td>
                  <td><Badge tone={c.verification_status === 'verified' ? 'ok' : c.verification_status === 'rejected' ? 'danger' : 'warn'}>{c.verification_status}</Badge></td>
                  <td>
                    {c.user_id ? 'Active' : admin && c.verification_status === 'verified' ? <Button variant="secondary" onClick={() => void invite(c)}>Invite</Button> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No coaches" />
        )}
      </Loading>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.full_name ?? ''} wide>
        {open && (
          <div className="flex flex-col gap-5">
            <KeyValue
              items={[
                ['Email', open.email], ['Phone', [open.phone_country_code, open.phone].filter(Boolean).join(' ')], ['Gym', open.gyms?.name],
                ['Location', [open.city, open.country].filter(Boolean).join(', ')], ['Experience', open.experience_summary], ['Verification info', open.verification_info],
                ['Declared roster', open.declared_roster.join(', ') || '—'], ['Registered', formatDate(open.created_at)],
              ]}
            />
            {open.coach_fighters.length > 0 && (
              <div>
                <h3 className="mb-2 font-semibold uppercase">Roster links</h3>
                <ul className="divide-y divide-ink-700">
                  {open.coach_fighters.map((l) => (
                    <li key={l.id} className="flex items-center justify-between py-2">
                      <span>{l.fighters?.fight_name} <span className="text-ink-400">{l.fighters?.fighter_code}</span></span>
                      <span className="flex items-center gap-2">
                        <Badge tone={l.status === 'approved' ? 'ok' : l.status === 'pending' ? 'warn' : 'neutral'}>{l.status}</Badge>
                        {admin && l.status === 'pending' && (
                          <>
                            <Button variant="secondary" onClick={() => void link(l.id, 'approved')}>Approve</Button>
                            <Button variant="ghost" onClick={() => void link(l.id, 'rejected')}>Reject</Button>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {admin && (
              <div className="flex flex-col gap-3 border-t border-ink-700 pt-4">
                <Textarea aria-label="Verification notes" placeholder="Verification notes (sent to the coach if rejected)" value={notes} onChange={(e) => setNotes(e.target.value)} />
                <div className="flex gap-2">
                  {open.verification_status !== 'verified' && <Button onClick={() => void verify(open, 'verified')}>Verify coach</Button>}
                  {open.verification_status !== 'rejected' && <Button variant="danger" onClick={() => void verify(open, 'rejected')} disabled={!notes.trim()}>Reject</Button>}
                </div>
                <p className="text-xs text-ink-400">Coaches only see private data of fighters on their approved roster.</p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
