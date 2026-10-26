import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { must, useAsync } from '@/hooks/useAsync';
import { formatWeight } from '@/lib/format';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/ui';
import { Section, Table } from '@/components/more';
import { Loading } from '@/components/Loading';
import { PasswordForm } from '@/components/PasswordForm';
import { RegistrationStatusBadge, type RegistrationStatus } from '@/components/StatusBadge';
import type { PublicEvent } from '@/pages/public/EventsList';

function CoachLogin() {
  const { signIn } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    setBusy(true);
    setErr(await signIn(String(d.get('email')), String(d.get('password'))));
    setBusy(false);
  }
  return (
    <Card className="mx-auto max-w-sm">
      <h1 className="mb-4 text-3xl font-bold uppercase">Coach sign in</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {err && <Alert>{err}</Alert>}
        <Field label="Email" required>{({ id }) => <Input id={id} name="email" type="email" autoComplete="email" />}</Field>
        <Field label="Password" required>{({ id }) => <Input id={id} name="password" type="password" autoComplete="current-password" />}</Field>
        <Button type="submit" loading={busy}>Sign in</Button>
        <p className="text-sm text-ink-400">Not registered? <Link to="/register/coach" className="underline">Register as a coach</Link>. Accounts are created after verification.</p>
      </form>
    </Card>
  );
}

interface RosterFighter {
  id: string; fighter_code: string; fight_name: string; division: string;
  event_registrations: { id: string; status: RegistrationStatus; declared_weight_g: number | null; events: { name: string } | null }[];
}

export function CoachPortal() {
  const { session, access, loading, signOut } = useAuth();
  const roster = useAsync(async () => {
    if (!access?.coach_id) return [];
    return must(await supabase.from('fighters').select('id, fighter_code, fight_name, division, event_registrations(id, status, declared_weight_g, events(name))').order('fight_name')) as unknown as RosterFighter[];
  }, [access?.coach_id]);
  const events = useAsync(async () => {
    const { data, error } = await supabase.rpc('public_list_events', { p_scope: 'upcoming' });
    if (error) throw error;
    return (data as PublicEvent[]).filter((e) => e.registration_open);
  }, []);
  const links = useAsync(async () => {
    if (!access?.coach_id) return [];
    return must(await supabase.from('coach_fighters').select('id, status, created_at').eq('coach_id', access.coach_id)) as { id: string; status: string; created_at: string }[];
  }, [access?.coach_id]);

  if (loading) return null;
  if (!session) return <CoachLogin />;
  if (!access?.coach_id)
    return (
      <Card className="mx-auto max-w-lg">
        <h1 className="text-3xl font-bold uppercase">Coach portal</h1>
        <p className="mt-2 text-ink-400">{session.user.email} is not linked to a verified coach profile. If you were just invited, an administrator may still need to complete verification.</p>
        <Button variant="secondary" className="mt-4" onClick={() => void signOut()}>Sign out</Button>
      </Card>
    );

  const pending = (links.data ?? []).filter((l) => l.status === 'pending').length;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Coach portal" description={session.user.email} actions={<Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>} />
      {pending > 0 && <Alert tone="info">{pending} roster link(s) are awaiting administrator approval.</Alert>}
      <Section title="Register a fighter">
        <p className="mb-3 text-sm text-ink-400">While signed in, fighters you register are linked to your roster automatically. Each fighter receives their own confirmation and fighter ID by email.</p>
        <Loading loading={events.loading} error={events.error}>
          {events.data?.length ? (
            <div className="flex flex-wrap gap-2">
              {events.data.map((e) => (
                <Link key={e.slug} to={`/register/fighter?event=${e.slug}`} className="inline-flex min-h-11 items-center rounded-md bg-accent-600 px-4 font-semibold text-white hover:bg-accent-500">
                  {e.name}
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-ink-400">No events are open for registration right now.</p>
          )}
        </Loading>
      </Section>
      <Section title="Your roster">
        <Loading loading={roster.loading} error={roster.error}>
          {roster.data?.length ? (
            <Table caption="Roster">
              <thead><tr><th>Fighter</th><th>Division</th><th>Registrations</th></tr></thead>
              <tbody>
                {roster.data.map((f) => (
                  <tr key={f.id}>
                    <td className="font-semibold">{f.fight_name}<div className="text-xs text-ink-400">{f.fighter_code}</div></td>
                    <td>{f.division}</td>
                    <td>
                      {f.event_registrations.map((r) => (
                        <div key={r.id} className="flex items-center gap-2 text-sm">
                          <RegistrationStatusBadge status={r.status} /> {r.events?.name} · {formatWeight(r.declared_weight_g)}
                        </div>
                      ))}
                      {!f.event_registrations.length && <Badge>Profile only</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="No fighters on your roster yet" />
          )}
        </Loading>
        <p className="mt-3 text-xs text-ink-400">You can only see fighters on your approved roster.</p>
      </Section>
      <Section title="Password">
        <PasswordForm />
      </Section>
    </div>
  );
}
