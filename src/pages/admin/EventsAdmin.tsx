import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { supabase, friendlyError } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { isOrgAdmin } from '@/lib/access';
import { must, useAsync } from '@/hooks/useAsync';
import { formatDate, humanize, venueText } from '@/lib/format';
import { Alert, Badge, Button, EmptyState, Field, Input, PageHeader } from '@/components/ui';
import { Modal, Table } from '@/components/more';
import { Loading } from '@/components/Loading';
import { slugify } from '@/lib/events';


export function EventsAdmin() {
  const { access, session } = useAuth();
  const navigate = useNavigate();
  const q = useAsync(
    async () =>
      must(await supabase.from('events').select('id, event_code, name, slug, status, starts_at, venue_name, venue_city, is_public, fight_card_published, event_registrations(count)').order('created_at', { ascending: false })) as {
        id: string; event_code: string; name: string; slug: string; status: string; starts_at: string | null; venue_name: string | null; venue_city: string | null; is_public: boolean; fight_card_published: boolean; event_registrations: { count: number }[];
      }[],
    [],
  );
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const s = slug || slugify(name);
    if (name.trim().length < 3 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) {
      setErr('Enter a name (3+ characters) and a URL slug using lowercase letters, numbers and hyphens.');
      return;
    }
    setBusy(true);
    const orgId = access?.org_roles.find((r) => r.role === 'org_admin')?.org_id ?? access?.org_roles[0]?.org_id;
    const { data, error } = await supabase.from('events').insert({ org_id: orgId, name: name.trim(), slug: s, created_by: session?.user.id }).select('id').single();
    setBusy(false);
    if (error) setErr(/duplicate/.test(error.message) ? 'That URL slug is already used by another event.' : friendlyError(error));
    else navigate(`/admin/events/${data.id}`);
  }

  return (
    <div>
      <PageHeader title="Events" actions={isOrgAdmin(access) && <Button onClick={() => setOpen(true)}>New event</Button>} />
      <Loading loading={q.loading} error={q.error}>
        {q.data?.length ? (
          <Table caption="Events">
            <thead>
              <tr>
                <th>Event</th>
                <th>Date</th>
                <th>Venue</th>
                <th>Status</th>
                <th>Registrations</th>
                <th>Public</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/admin/events/${e.id}`} className="font-semibold hover:underline">
                      {e.name}
                    </Link>
                    <div className="text-xs text-ink-400">{e.event_code} · /{e.slug}</div>
                  </td>
                  <td>{formatDate(e.starts_at)}</td>
                  <td>{venueText(e)}</td>
                  <td>
                    <Badge tone={e.status === 'cancelled' ? 'danger' : e.status === 'registration_open' ? 'ok' : 'neutral'}>{humanize(e.status)}</Badge>
                  </td>
                  <td>{e.event_registrations?.[0]?.count ?? 0}</td>
                  <td>{e.is_public ? (e.fight_card_published ? 'Card published' : 'Event page') : 'Hidden'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No events yet">{isOrgAdmin(access) ? 'Create your first event.' : 'You have not been assigned to an event.'}</EmptyState>
        )}
      </Loading>
      <Modal open={open} onClose={() => setOpen(false)} title="New event">
        <form onSubmit={create} className="flex flex-col gap-4">
          {err && <Alert>{err}</Alert>}
          <Field label="Event name" required>
            {({ id }) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slug) setSlug('');
                }}
              />
            )}
          </Field>
          <Field label="URL slug" hint={`Public address: /events/${slug || slugify(name) || 'your-event'}`}>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={slug} placeholder={slugify(name)} onChange={(e) => setSlug(slugify(e.target.value))} />}
          </Field>
          <p className="text-sm text-ink-400">The event starts as a hidden draft with a copy of your organisation's weight classes and matchmaking rules. Date and venue can stay “To Be Announced”.</p>
          <Button type="submit" loading={busy}>
            Create event
          </Button>
        </form>
      </Modal>
    </div>
  );
}
