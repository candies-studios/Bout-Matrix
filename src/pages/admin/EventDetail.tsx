import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { resolveRules, type MatchRules } from '@domain/matchmaking.ts';
import { toGrams } from '@domain/weights.ts';
import { supabase, friendlyError, siteUrl } from '@/lib/supabase';
import { callFunction } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isOrgAdmin } from '@/lib/access';
import { must, useAsync } from '@/hooks/useAsync';
import { fromLocalInput, humanize, toLocalInput } from '@/lib/format';
import { Alert, Badge, Button, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { Checkbox, CopyButton, Section, Table, Tabs } from '@/components/more';
import { ShareButtons } from '@/components/ShareButtons';
import { Loading } from '@/components/Loading';
import { EVENT_STATUSES } from '@/lib/events';

type Tab = 'details' | 'links' | 'weights' | 'rules' | 'staff' | 'announce';

interface EventRow {
  id: string; org_id: string; event_code: string; slug: string; name: string; promotion: string | null; description: string | null;
  branding: { primary_color?: string }; registration_opens_at: string | null; registration_closes_at: string | null; starts_at: string | null;
  timezone: string; venue_name: string | null; venue_address: string | null; venue_city: string | null; venue_country: string | null; status: string;
  is_public: boolean; fight_card_published: boolean; allow_late_registration: boolean; rules_text: string | null; default_rounds: number;
  default_round_minutes: number; offer_validity_hours: number; notify_coaches: boolean;
  eligibility: { min_age?: number; max_age?: number; divisions?: string[]; competition_levels?: string[]; require_clearance?: boolean; required_documents?: string[] };
}

export function EventDetail() {
  const { eventId } = useParams();
  const { access } = useAuth();
  const [tab, setTab] = useState<Tab>('details');
  const q = useAsync(async () => must(await supabase.from('events').select('*').eq('id', eventId).single()) as EventRow, [eventId]);
  const e = q.data;
  return (
    <Loading loading={q.loading} error={q.error}>
      {e && (
        <div>
          <Link to="/admin/events" className="text-sm text-ink-400 hover:text-ink-100">
            ← Events
          </Link>
          <PageHeader
            title={e.name}
            description={
              <span className="flex flex-wrap items-center gap-2">
                {e.event_code} <Badge>{humanize(e.status)}</Badge> {e.is_public ? <Badge tone="ok">Public</Badge> : <Badge>Hidden</Badge>}
              </span>
            }
            actions={
              e.is_public && (
                <Link className="text-sm font-semibold text-accent-400 hover:underline" to={`/events/${e.slug}`} target="_blank" rel="noreferrer">
                  View public page ↗
                </Link>
              )
            }
          />
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: 'details', label: 'Details' },
              { value: 'links', label: 'Registration links' },
              { value: 'weights', label: 'Weight classes' },
              { value: 'rules', label: 'Matchmaking rules' },
              ...(isOrgAdmin(access) ? [{ value: 'staff' as Tab, label: 'Staff' }] : []),
              { value: 'announce', label: 'Announce' },
            ]}
          />
          {tab === 'details' && <DetailsForm e={e} onSaved={q.reload} />}
          {tab === 'links' && <Links e={e} />}
          {tab === 'weights' && <WeightClasses eventId={e.id} orgId={e.org_id} />}
          {tab === 'rules' && <RulesEditor eventId={e.id} orgId={e.org_id} />}
          {tab === 'staff' && <Staff eventId={e.id} />}
          {tab === 'announce' && <Announce eventId={e.id} />}
        </div>
      )}
    </Loading>
  );
}

function DetailsForm({ e, onSaved }: { e: EventRow; onSaved: () => void }) {
  const [v, setV] = useState(() => ({
    ...e,
    registration_opens_at: toLocalInput(e.registration_opens_at),
    registration_closes_at: toLocalInput(e.registration_closes_at),
    starts_at: toLocalInput(e.starts_at),
    divisions: (e.eligibility.divisions ?? []).join(', '),
    levels: (e.eligibility.competition_levels ?? []).join(', '),
    docs: (e.eligibility.required_documents ?? []).join(', '),
    min_age: e.eligibility.min_age?.toString() ?? '',
    max_age: e.eligibility.max_age?.toString() ?? '',
    require_clearance: Boolean(e.eligibility.require_clearance),
    color: e.branding.primary_color ?? '#DC2626',
  }));
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (x: { target: { value: string } }) => setV((p) => ({ ...p, [k]: x.target.value }));
  const list = (s: string) => s.split(',').map((x) => x.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await supabase
      .from('events')
      .update({
        name: v.name.trim(),
        promotion: v.promotion || null,
        description: v.description || null,
        registration_opens_at: fromLocalInput(v.registration_opens_at),
        registration_closes_at: fromLocalInput(v.registration_closes_at),
        starts_at: fromLocalInput(v.starts_at),
        timezone: v.timezone || 'UTC',
        venue_name: v.venue_name || null,
        venue_address: v.venue_address || null,
        venue_city: v.venue_city || null,
        venue_country: v.venue_country || null,
        status: v.status,
        is_public: v.is_public,
        allow_late_registration: v.allow_late_registration,
        rules_text: v.rules_text || null,
        default_rounds: Number(v.default_rounds),
        default_round_minutes: Number(v.default_round_minutes),
        offer_validity_hours: Number(v.offer_validity_hours),
        notify_coaches: v.notify_coaches,
        branding: { ...e.branding, primary_color: v.color },
        eligibility: {
          min_age: v.min_age ? Number(v.min_age) : undefined,
          max_age: v.max_age ? Number(v.max_age) : undefined,
          divisions: list(v.divisions),
          competition_levels: list(v.levels),
          require_clearance: v.require_clearance,
          required_documents: list(v.docs),
        },
      })
      .eq('id', e.id);
    setBusy(false);
    if (error) setMsg({ tone: 'danger', text: friendlyError(error) });
    else {
      setMsg({ tone: 'ok', text: 'Saved. Fighters with live offers or booked bouts are emailed automatically if the date or venue changed.' });
      onSaved();
    }
  }

  const text = (k: keyof typeof v, label: string, type = 'text', hint?: string) => (
    <Field label={label} hint={hint}>
      {({ id, describedBy }) => <Input id={id} type={type} aria-describedby={describedBy} value={String(v[k] ?? '')} onChange={set(k as string)} />}
    </Field>
  );

  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Section title="Event">
        <div className="grid gap-4 md:grid-cols-2">
          {text('name', 'Name')}
          {text('promotion', 'Promotion / organisation')}
          <Field label="Status">
            {({ id }) => (
              <Select id={id} value={v.status} onChange={set('status')}>
                {EVENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {text('color', 'Brand colour', 'color')}
          <div className="md:col-span-2">
            <Field label="Description">{({ id }) => <Textarea id={id} value={v.description ?? ''} onChange={set('description')} />}</Field>
          </div>
          <Checkbox id="is_public" checked={v.is_public} onChange={(b) => setV((p) => ({ ...p, is_public: b }))} label="Show the event page publicly" description="Draft events cannot be public." />
          <Checkbox id="notify_coaches" checked={v.notify_coaches} onChange={(b) => setV((p) => ({ ...p, notify_coaches: b }))} label="Email approved coaches about their fighters' offers" />
        </div>
      </Section>
      <Section title="Date & venue">
        <p className="mb-4 text-sm text-ink-400">Leave blank to show “To Be Announced”.</p>
        <div className="grid gap-4 md:grid-cols-2">
          {text('starts_at', 'Event date & time', 'datetime-local')}
          {text('timezone', 'Time zone', 'text', 'IANA name, e.g. Asia/Kolkata')}
          {text('venue_name', 'Venue')}
          {text('venue_address', 'Address')}
          {text('venue_city', 'City')}
          {text('venue_country', 'Country')}
        </div>
      </Section>
      <Section title="Registration & eligibility">
        <div className="grid gap-4 md:grid-cols-2">
          {text('registration_opens_at', 'Registration opens', 'datetime-local')}
          {text('registration_closes_at', 'Registration closes', 'datetime-local')}
          {text('min_age', 'Minimum age', 'number')}
          {text('max_age', 'Maximum age', 'number')}
          {text('divisions', 'Divisions', 'text', 'Comma separated, e.g. men, women')}
          {text('levels', 'Competition levels', 'text', 'amateur, semi_pro, professional')}
          {text('docs', 'Required documents', 'text', 'Comma separated, e.g. id_proof, medical_clearance_certificate')}
          <div className="flex flex-col gap-3">
            <Checkbox id="clear" checked={v.require_clearance} onChange={(b) => setV((p) => ({ ...p, require_clearance: b }))} label="Require clearance before matchmaking" />
            <Checkbox id="late" checked={v.allow_late_registration} onChange={(b) => setV((p) => ({ ...p, allow_late_registration: b }))} label="Accept late registrations" />
          </div>
        </div>
      </Section>
      <Section title="Bout defaults & rules">
        <div className="grid gap-4 md:grid-cols-3">
          {text('default_rounds', 'Rounds', 'number')}
          {text('default_round_minutes', 'Minutes per round', 'number')}
          {text('offer_validity_hours', 'Offer valid for (hours)', 'number')}
          <div className="md:col-span-3">
            <Field label="Competition rules">{({ id }) => <Textarea id={id} value={v.rules_text ?? ''} onChange={set('rules_text')} />}</Field>
          </div>
        </div>
      </Section>
      <Button type="submit" loading={busy} className="self-start">
        Save event
      </Button>
    </form>
  );
}

function Links({ e }: { e: EventRow }) {
  const base = siteUrl.replace(/\/$/, '');
  const links = [
    { label: 'Fighter registration', url: `${base}/register/fighter?event=${e.slug}` },
    { label: 'Coach & gym registration', url: `${base}/register/coach?event=${e.slug}` },
    { label: 'Public event page', url: `${base}/events/${e.slug}` },
    { label: 'Public fight card', url: `${base}/events/${e.slug}/fight-card` },
  ];
  return (
    <div className="flex flex-col gap-4">
      {e.status !== 'registration_open' && <Alert tone="warn">Registration links only accept submissions while the event status is “Registration open” and within the registration window.</Alert>}
      {links.map((l) => (
        <Section key={l.label} title={l.label}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <code className="flex-1 break-all rounded bg-ink-800 px-3 py-2 text-sm">{l.url}</code>
            <ShareButtons url={l.url} text={`${e.name} — ${l.label}`} />
          </div>
        </Section>
      ))}
    </div>
  );
}

interface WC { id: string; name: string; division: string | null; min_g: number | null; max_g: number; allowed_diff_g: number; is_active: boolean; sort_order: number }

export function WeightClasses({ eventId, orgId }: { eventId: string | null; orgId: string }) {
  const q = useAsync(async () => {
    let query = supabase.from('weight_classes').select('id, name, division, min_g, max_g, allowed_diff_g, is_active, sort_order').eq('org_id', orgId);
    query = eventId ? query.eq('event_id', eventId) : query.is('event_id', null);
    return must(await query.order('division').order('max_g')) as WC[];
  }, [eventId, orgId]);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', division: 'men', min: '', max: '', diff: '2.3' });
  const kg = (g: number | null) => (g == null ? '' : (g / 1000).toFixed(2));

  async function update(id: string, patch: Partial<WC>) {
    const { error } = await supabase.from('weight_classes').update(patch).eq('id', id);
    if (error) setErr(friendlyError(error));
    else void q.reload();
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const max = Number(draft.max);
    if (!draft.name.trim() || !(max > 0)) return setErr('Name and upper limit are required.');
    const { error } = await supabase.from('weight_classes').insert({
      org_id: orgId, event_id: eventId, name: draft.name.trim(), division: draft.division || null,
      min_g: draft.min ? toGrams(Number(draft.min), 'kg') : null, max_g: toGrams(max, 'kg'), allowed_diff_g: toGrams(Number(draft.diff || 0.001), 'kg'),
    });
    if (error) setErr(friendlyError(error));
    else {
      setDraft({ name: '', division: draft.division, min: '', max: '', diff: draft.diff });
      void q.reload();
    }
  }

  return (
    <Loading loading={q.loading} error={q.error}>
      {err && <div className="mb-3"><Alert>{err}</Alert></div>}
      <p className="mb-3 text-sm text-ink-400">Limits in kilograms. Upper limit is inclusive; lower limit is exclusive. “Allowed difference” is the largest permitted weight gap between opponents in the class.</p>
      <Table caption="Weight classes">
        <thead>
          <tr>
            <th>Name</th>
            <th>Division</th>
            <th>Above (kg)</th>
            <th>Up to (kg)</th>
            <th>Allowed diff (kg)</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((w) => (
            <tr key={w.id}>
              <td>{w.name}</td>
              <td>{w.division ?? 'Any'}</td>
              <td>{kg(w.min_g) || '—'}</td>
              <td>
                <Input aria-label={`${w.name} upper limit`} type="number" step="0.01" defaultValue={kg(w.max_g)} className="w-28" onBlur={(e) => Number(e.target.value) > 0 && toGrams(Number(e.target.value), 'kg') !== w.max_g && void update(w.id, { max_g: toGrams(Number(e.target.value), 'kg') })} />
              </td>
              <td>
                <Input aria-label={`${w.name} allowed difference`} type="number" step="0.1" defaultValue={kg(w.allowed_diff_g)} className="w-24" onBlur={(e) => Number(e.target.value) >= 0 && void update(w.id, { allowed_diff_g: Math.round(Number(e.target.value) * 1000) })} />
              </td>
              <td>
                <input type="checkbox" aria-label={`${w.name} active`} className="h-5 w-5 accent-accent-600" checked={w.is_active} onChange={(e) => void update(w.id, { is_active: e.target.checked })} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <form onSubmit={add} className="mt-4 grid gap-3 rounded-lg border border-ink-700 p-4 md:grid-cols-6">
        <Input aria-label="New class name" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="md:col-span-2" />
        <Select aria-label="Division" value={draft.division} onChange={(e) => setDraft({ ...draft, division: e.target.value })}>
          <option value="men">men</option>
          <option value="women">women</option>
          <option value="">any</option>
        </Select>
        <Input aria-label="Above kg" placeholder="Above kg" type="number" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} />
        <Input aria-label="Up to kg" placeholder="Up to kg" type="number" value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} />
        <Button type="submit">Add class</Button>
      </form>
    </Loading>
  );
}

const RULE_FIELDS: [keyof MatchRules, string, string][] = [
  ['max_weight_diff_g', 'Max weight difference (g)', 'Hard limit across all classes (class allowance also applies).'],
  ['max_experience_gap_soft', 'Experience gap → review (fights)', ''],
  ['max_experience_gap_hard', 'Experience gap → ineligible (fights)', ''],
  ['max_age_gap_years_soft', 'Age gap → review (years)', ''],
  ['weight_stale_after_days', 'Weight is stale after (days)', ''],
  ['strong_threshold', 'Strong candidate score ≥', ''],
  ['possible_threshold', 'Possible candidate score ≥', ''],
];

export function RulesEditor({ eventId, orgId }: { eventId: string | null; orgId: string }) {
  const q = useAsync(async () => {
    let query = supabase.from('matchmaking_rules').select('id, config').eq('org_id', orgId);
    query = eventId ? query.eq('event_id', eventId) : query.is('event_id', null);
    return (must(await query.maybeSingle()) ?? null) as { id: string; config: Partial<MatchRules> } | null;
  }, [eventId, orgId]);
  return (
    <Loading loading={q.loading} error={q.error}>
      {q.data !== undefined && <RulesForm key={q.data?.id ?? 'new'} existing={q.data} eventId={eventId} orgId={orgId} onSaved={q.reload} />}
    </Loading>
  );
}

function RulesForm({ existing, eventId, orgId, onSaved }: { existing: { id: string; config: Partial<MatchRules> } | null; eventId: string | null; orgId: string; onSaved: () => void }) {
  const [r, setR] = useState<MatchRules>(() => resolveRules(existing?.config));
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const res = existing
      ? await supabase.from('matchmaking_rules').update({ config: r }).eq('id', existing.id)
      : await supabase.from('matchmaking_rules').insert({ org_id: orgId, event_id: eventId, config: r });
    setMsg(res.error ? { tone: 'danger', text: friendlyError(res.error) } : { tone: 'ok', text: 'Rules saved. Regenerate suggestions to apply them.' });
    if (!res.error && !existing) onSaved();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Alert tone="info">Scores support the matchmaker's judgement; they are not a safety guarantee. Every pairing is reviewed and approved by a person.</Alert>
      <Section title="Score weighting">
        <div className="grid gap-4 md:grid-cols-5">
          {(Object.keys(r.weights) as (keyof MatchRules['weights'])[]).map((k) => (
            <Field key={k} label={humanize(k)}>
              {({ id }) => <Input id={id} type="number" min={0} max={100} value={r.weights[k]} onChange={(e) => setR({ ...r, weights: { ...r.weights, [k]: Number(e.target.value) } })} />}
            </Field>
          ))}
        </div>
      </Section>
      <Section title="Eligibility thresholds">
        <div className="grid gap-4 md:grid-cols-3">
          {RULE_FIELDS.map(([k, label, hint]) => (
            <Field key={k} label={label} hint={hint || undefined}>
              {({ id }) => <Input id={id} type="number" value={Number(r[k])} onChange={(e) => setR({ ...r, [k]: Number(e.target.value) })} />}
            </Field>
          ))}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {([
            ['require_same_division', 'Opponents must share a division'],
            ['require_same_competition_level', 'Opponents must share a competition level'],
            ['require_verified_record', 'Unverified records require review'],
            ['allow_rematch', 'Allow rematches'],
          ] as [keyof MatchRules, string][]).map(([k, label]) => (
            <Checkbox key={k} id={k} checked={Boolean(r[k])} onChange={(b) => setR({ ...r, [k]: b })} label={label} />
          ))}
        </div>
      </Section>
      <Button type="submit" className="self-start">
        Save rules
      </Button>
    </form>
  );
}

function Staff({ eventId }: { eventId: string }) {
  const q = useAsync(async () => {
    const admins = must(await supabase.from('event_admins').select('id, user_id, role').eq('event_id', eventId)) as { id: string; user_id: string; role: string }[];
    const users = must(await supabase.from('user_profiles').select('id, email, full_name').order('full_name')) as { id: string; email: string; full_name: string | null }[];
    return { admins, users };
  }, [eventId]);
  const { session } = useAuth();
  const [pick, setPick] = useState({ user: '', role: 'matchmaker' });
  const [invite, setInvite] = useState({ email: '', full_name: '', role: 'matchmaker' });
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const userName = (id: string) => q.data?.users.find((u) => u.id === id);

  async function assign() {
    if (!pick.user) return;
    const { error } = await supabase.from('event_admins').insert({ event_id: eventId, user_id: pick.user, role: pick.role, granted_by: session?.user.id });
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text: 'Assigned. The user also needs the Staff role (Settings → Users).' });
    void q.reload();
  }
  async function remove(id: string) {
    const { error } = await supabase.from('event_admins').delete().eq('id', id);
    if (error) setMsg({ tone: 'danger', text: friendlyError(error) });
    void q.reload();
  }
  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    try {
      await callFunction('invite-staff', { email: invite.email, full_name: invite.full_name, role: 'staff', event_id: eventId, event_role: invite.role });
      setMsg({ tone: 'ok', text: `Invitation sent to ${invite.email}.` });
      setInvite({ email: '', full_name: '', role: 'matchmaker' });
      void q.reload();
    } catch (err) {
      setMsg({ tone: 'danger', text: (err as Error).message });
    }
  }

  return (
    <Loading loading={q.loading} error={q.error}>
      <div className="flex flex-col gap-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Section title="Assigned staff">
          <p className="mb-3 text-sm text-ink-400">Event admins can approve registrations, confirm and publish bouts. Matchmakers can review registrants, create bouts and send offers. Organisation admins can do everything.</p>
          <ul className="divide-y divide-ink-700">
            {q.data?.admins.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2">
                <span>
                  {userName(a.user_id)?.full_name ?? userName(a.user_id)?.email ?? a.user_id} <Badge>{humanize(a.role)}</Badge>
                </span>
                <Button variant="ghost" onClick={() => void remove(a.id)}>
                  Remove
                </Button>
              </li>
            ))}
            {!q.data?.admins.length && <li className="py-2 text-ink-400">No event-specific staff.</li>}
          </ul>
          <div className="mt-4 flex flex-col gap-2 md:flex-row">
            <Select aria-label="User" value={pick.user} onChange={(e) => setPick({ ...pick, user: e.target.value })}>
              <option value="">Choose a user…</option>
              {q.data?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name ?? u.email} ({u.email})
                </option>
              ))}
            </Select>
            <Select aria-label="Role" value={pick.role} onChange={(e) => setPick({ ...pick, role: e.target.value })} className="md:w-48">
              <option value="matchmaker">Matchmaker</option>
              <option value="event_admin">Event admin</option>
            </Select>
            <Button onClick={() => void assign()}>Assign</Button>
          </div>
        </Section>
        <Section title="Invite someone new">
          <form onSubmit={sendInvite} className="grid gap-3 md:grid-cols-4">
            <Input aria-label="Full name" placeholder="Full name" value={invite.full_name} onChange={(e) => setInvite({ ...invite, full_name: e.target.value })} />
            <Input aria-label="Email" placeholder="Email" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            <Select aria-label="Role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              <option value="matchmaker">Matchmaker</option>
              <option value="event_admin">Event admin</option>
            </Select>
            <Button type="submit">Send invitation</Button>
          </form>
        </Section>
      </div>
    </Loading>
  );
}

function Announce({ eventId }: { eventId: string }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function send() {
    if (!window.confirm('Email this announcement to every fighter registered for this event?')) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('announce_event', { p_event: eventId, p_message: text });
    setBusy(false);
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text: `Queued ${data} email(s). Delivery status is shown under Emails.` });
    if (!error) setText('');
  }
  return (
    <Section title="Event announcement">
      {msg && <div className="mb-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      <p className="mb-3 text-sm text-ink-400">Sent to fighters with submitted, under-review or approved registrations who have not opted out of announcements.</p>
      <Textarea aria-label="Announcement" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => void send()} loading={busy} disabled={text.trim().length < 5}>
          Send announcement
        </Button>
        <CopyButton text={text} label="Copy text" />
      </div>
    </Section>
  );
}
