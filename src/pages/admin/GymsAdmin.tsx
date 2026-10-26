import { useState, type FormEvent } from 'react';
import { supabase, friendlyError } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { isOrgAdmin } from '@/lib/access';
import { must, useAsync } from '@/hooks/useAsync';
import { Alert, Badge, Button, EmptyState, Input, PageHeader, Select } from '@/components/ui';
import { Table } from '@/components/more';
import { Loading } from '@/components/Loading';

interface Gym { id: string; org_id: string; name: string; city: string | null; country: string | null; website: string | null; verification_status: string; is_public: boolean; fighters: { count: number }[]; coaches: { count: number }[] }

export function GymsAdmin() {
  const { access } = useAuth();
  const admin = isOrgAdmin(access);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useAsync(async () => must(await supabase.from('gyms').select('*, fighters(count), coaches(count)').order('name')) as unknown as Gym[], []);
  async function patch(id: string, values: Partial<Gym>) {
    const { error } = await supabase.from('gyms').update(values).eq('id', id);
    if (error) setErr(friendlyError(error));
    void q.reload();
  }
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const org = access?.org_roles.find((r) => r.role === 'org_admin')?.org_id ?? access?.org_roles[0]?.org_id;
    const { error } = await supabase.from('gyms').insert({ org_id: org, name: d.name, city: d.city || null, country: d.country || null, verification_status: 'verified' });
    if (error) setErr(/duplicate/.test(error.message) ? 'A gym with that name already exists in that city.' : friendlyError(error));
    else {
      e.currentTarget.reset();
      void q.reload();
    }
  }
  const rows = (q.data ?? []).filter((g) => !search || g.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader title="Gyms" actions={<Input aria-label="Search gyms" type="search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />} />
      {err && <div className="mb-4"><Alert>{err}</Alert></div>}
      <p className="mb-4 text-sm text-ink-400">Gyms created from registration forms start as pending. Only verified, public gyms appear in registration drop-downs and on fight cards.</p>
      <Loading loading={q.loading} error={q.error}>
        {rows.length ? (
          <Table caption="Gyms">
            <thead><tr><th>Gym</th><th>Location</th><th>Fighters</th><th>Coaches</th><th>Status</th><th>Shown publicly</th></tr></thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id}>
                  <td className="font-semibold">{g.name}</td>
                  <td>{[g.city, g.country].filter(Boolean).join(', ') || '—'}</td>
                  <td>{g.fighters?.[0]?.count ?? 0}</td>
                  <td>{g.coaches?.[0]?.count ?? 0}</td>
                  <td>
                    {admin ? (
                      <Select aria-label={`${g.name} status`} value={g.verification_status} onChange={(e) => void patch(g.id, { verification_status: e.target.value })} className="w-36">
                        <option value="pending">Pending</option>
                        <option value="verified">Verified</option>
                        <option value="rejected">Rejected</option>
                      </Select>
                    ) : (
                      <Badge>{g.verification_status}</Badge>
                    )}
                  </td>
                  <td>
                    <input type="checkbox" aria-label={`${g.name} public`} className="h-5 w-5 accent-accent-600" checked={g.is_public} disabled={!admin} onChange={(e) => void patch(g.id, { is_public: e.target.checked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No gyms" />
        )}
      </Loading>
      {admin && (
        <form onSubmit={add} className="mt-4 grid gap-2 rounded-lg border border-ink-700 p-4 md:grid-cols-4">
          <Input name="name" aria-label="Gym name" placeholder="Gym name" required minLength={2} />
          <Input name="city" aria-label="City" placeholder="City" />
          <Input name="country" aria-label="Country" placeholder="Country" />
          <Button type="submit">Add gym</Button>
        </form>
      )}
    </div>
  );
}
