import { useState, type FormEvent } from 'react';
import { KNOWN_TEMPLATES, renderEmail } from '@domain/emailTemplates.ts';
import { supabase, friendlyError, siteUrl } from '@/lib/supabase';
import { callFunction } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { must, useAsync } from '@/hooks/useAsync';
import { humanize } from '@/lib/format';
import { Alert, Badge, Button, Field, Input, PageHeader, Select } from '@/components/ui';
import { Section, Tabs } from '@/components/more';
import { Loading } from '@/components/Loading';
import { RulesEditor, WeightClasses } from './EventDetail';

type Tab = 'organisation' | 'weights' | 'rules' | 'users' | 'emails';

export function Settings() {
  const { access } = useAuth();
  const orgId = access?.org_roles.find((r) => r.role === 'org_admin')?.org_id ?? access?.org_roles[0]?.org_id ?? '';
  const [tab, setTab] = useState<Tab>('organisation');
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'organisation', label: 'Organisation' },
          { value: 'weights', label: 'Weight class templates' },
          { value: 'rules', label: 'Default matchmaking rules' },
          { value: 'users', label: 'Users & roles' },
          { value: 'emails', label: 'Email templates' },
        ]}
      />
      {tab === 'organisation' && <Organisation orgId={orgId} />}
      {tab === 'weights' && (
        <>
          <p className="mb-3 text-sm text-ink-400">Templates are copied into each new event. Changing them does not alter existing events.</p>
          <WeightClasses eventId={null} orgId={orgId} />
        </>
      )}
      {tab === 'rules' && <RulesEditor eventId={null} orgId={orgId} />}
      {tab === 'users' && <Users orgId={orgId} />}
      {tab === 'emails' && <EmailPreview />}
    </div>
  );
}

function Organisation({ orgId }: { orgId: string }) {
  const q = useAsync(async () => must(await supabase.from('organizations').select('id, name, slug, fighter_id_prefix, contact_email, branding').eq('id', orgId).single()) as { id: string; name: string; slug: string; fighter_id_prefix: string; contact_email: string | null; branding: { primary_color?: string } }, [orgId]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const prefix = d.fighter_id_prefix.toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(prefix)) return setMsg({ tone: 'danger', text: 'Prefix must be 2–8 capital letters or digits.' });
    if (prefix !== q.data?.fighter_id_prefix && !window.confirm(`Change the prefix to ${prefix}? Existing fighter IDs keep their old prefix; new IDs continue the same number sequence.`)) return;
    const { error } = await supabase.from('organizations').update({ name: d.name, contact_email: d.contact_email.toLowerCase() || null, fighter_id_prefix: prefix, branding: { ...q.data?.branding, primary_color: d.color } }).eq('id', orgId);
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text: 'Saved.' });
    void q.reload();
  }
  return (
    <Loading loading={q.loading} error={q.error}>
      {q.data && (
        <Section title="Organisation">
          {msg && <div className="mb-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
          <form onSubmit={save} className="grid gap-4 md:grid-cols-2">
            <Field label="Name">{({ id }) => <Input id={id} name="name" defaultValue={q.data!.name} />}</Field>
            <Field label="Contact email">{({ id }) => <Input id={id} name="contact_email" type="email" defaultValue={q.data!.contact_email ?? ''} />}</Field>
            <Field label="Fighter ID prefix" hint={`New IDs look like ${q.data.fighter_id_prefix}-F-0001`}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} name="fighter_id_prefix" defaultValue={q.data!.fighter_id_prefix} maxLength={8} />}</Field>
            <Field label="Brand colour">{({ id }) => <Input id={id} name="color" type="color" defaultValue={q.data!.branding.primary_color ?? '#DC2626'} />}</Field>
            <Button type="submit" className="self-start">Save</Button>
          </form>
        </Section>
      )}
    </Loading>
  );
}

function Users({ orgId }: { orgId: string }) {
  const { session } = useAuth();
  const q = useAsync(async () => {
    const users = must(await supabase.from('user_profiles').select('id, email, full_name').eq('org_id', orgId).order('email')) as { id: string; email: string; full_name: string | null }[];
    const roles = must(await supabase.from('user_roles').select('id, user_id, role').eq('org_id', orgId)) as { id: string; user_id: string; role: string }[];
    return { users, roles };
  }, [orgId]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [inv, setInv] = useState({ email: '', full_name: '', role: 'staff' });
  async function removeRole(id: string) {
    if (!window.confirm('Remove this role?')) return;
    const { error } = await supabase.from('user_roles').delete().eq('id', id);
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text: 'Role removed.' });
    void q.reload();
  }
  async function grant(userId: string, role: string) {
    const { error } = await supabase.from('user_roles').insert({ user_id: userId, org_id: orgId, role, granted_by: session?.user.id });
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text: 'Role granted.' });
    void q.reload();
  }
  async function invite(e: FormEvent) {
    e.preventDefault();
    try {
      await callFunction('invite-staff', inv);
      setMsg({ tone: 'ok', text: `Invitation sent to ${inv.email}.` });
      setInv({ email: '', full_name: '', role: 'staff' });
      void q.reload();
    } catch (err) {
      setMsg({ tone: 'danger', text: (err as Error).message });
    }
  }
  return (
    <Loading loading={q.loading} error={q.error}>
      <div className="flex flex-col gap-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Section title="Users">
          <p className="mb-3 text-sm text-ink-400">
            Organisation admins manage everything. Staff only see events they are assigned to (Events → Staff) as event admin or matchmaker. Coaches use the coach portal. Public sign-up is disabled.
          </p>
          <ul className="divide-y divide-ink-700">
            {q.data?.users.map((u) => {
              const mine = q.data!.roles.filter((r) => r.user_id === u.id);
              return (
                <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <span>{u.full_name ?? u.email} <span className="text-ink-400">{u.email}</span></span>
                  <span className="flex flex-wrap items-center gap-2">
                    {mine.map((r) => (
                      <span key={r.id} className="flex items-center gap-1">
                        <Badge tone={r.role === 'org_admin' || r.role === 'super_admin' ? 'danger' : 'info'}>{humanize(r.role)}</Badge>
                        {u.id !== session?.user.id && r.role !== 'super_admin' && <button aria-label={`Remove ${r.role}`} className="text-ink-400 hover:text-accent-400" onClick={() => void removeRole(r.id)}>×</button>}
                      </span>
                    ))}
                    {!mine.some((r) => r.role === 'staff') && <Button variant="ghost" onClick={() => void grant(u.id, 'staff')}>+ Staff</Button>}
                    {!mine.some((r) => r.role === 'org_admin') && <Button variant="ghost" onClick={() => void grant(u.id, 'org_admin')}>+ Org admin</Button>}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
        <Section title="Invite a user">
          <form onSubmit={invite} className="grid gap-3 md:grid-cols-4">
            <Input aria-label="Full name" placeholder="Full name" value={inv.full_name} onChange={(e) => setInv({ ...inv, full_name: e.target.value })} />
            <Input aria-label="Email" placeholder="Email" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            <Select aria-label="Role" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
              <option value="staff">Staff</option>
              <option value="org_admin">Organisation admin</option>
            </Select>
            <Button type="submit">Send invitation</Button>
          </form>
        </Section>
      </div>
    </Loading>
  );
}

const SAMPLE = {
  fighter_name: 'Arjun Rao', fighter_code: 'WDS-F-0001', event_name: 'Demo Fight Night 1', event_slug: 'demo-fight-night-1', opponent_name: 'Kabir Sen',
  weight_class: 'Lightweight', rounds: 3, round_minutes: 5, starts_at: null, venue_name: null, expires_at: new Date(Date.now() + 72 * 3600e3).toISOString(),
  bout_code: 'WDS-B-0001', bout_id: 'sample', coach_name: 'Coach Ravi', missing_info: ['profile_photo', 'id_proof'], reason: 'Example reason', response: 'accept',
  message: 'Weigh-ins are on Friday at 10:00.',
};

function EmailPreview() {
  const [t, setT] = useState<string>('bout_offer');
  const r = renderEmail(t, SAMPLE, { siteUrl, orgName: 'Your Promotion', actionUrl: `${siteUrl}/offers/EXAMPLE` });
  return (
    <Section title="Email templates" actions={
      <Select aria-label="Template" value={t} onChange={(e) => setT(e.target.value)} className="w-72">
        {KNOWN_TEMPLATES.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
      </Select>
    }>
      <p className="mb-3 text-sm text-ink-400">Templates are version-controlled in <code>supabase/functions/_shared/domain/emailTemplates.ts</code> and deployed with the dispatcher. Preview with sample data:</p>
      <p className="mb-2"><strong>Subject:</strong> {r.subject}</p>
      <iframe title="Email preview" srcDoc={r.html} sandbox="" className="h-[560px] w-full rounded border border-ink-700 bg-white" />
    </Section>
  );
}
