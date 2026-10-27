import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toGrams } from '@domain/weights.ts';
import { supabase, friendlyError } from '@/lib/supabase';
import { callFunction, publicMediaUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isOrgAdmin } from '@/lib/access';
import { must, useAsync } from '@/hooks/useAsync';
import { formatDate, formatDateTime, formatWeight, humanize, recordText } from '@/lib/format';
import { Alert, Badge, Button, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { KeyValue, Modal, Section, Table } from '@/components/more';
import { Loading } from '@/components/Loading';
import { BoutStatusBadge, RegistrationStatusBadge, type RegistrationStatus } from '@/components/StatusBadge';
import type { BoutStatus } from '@domain/boutStatus.ts';

const nowIso = () => new Date().toISOString();

interface Rec { id: string; kind: 'self_reported' | 'verified'; wins: number; losses: number; draws: number; no_contests: number; ko_tko_wins: number | null; submission_wins: number | null; decision_wins: number | null; verified_at: string | null; source_note: string | null }
interface Reg {
  id: string; event_id: string; status: RegistrationStatus; submitted_via: string; declared_weight_g: number | null; weight_recorded_at: string | null;
  division: string; competition_level: string; is_available: boolean; availability_notes: string | null; clearance_status: string;
  missing_info: string[]; review_notes: string | null; rejection_reason: string | null; submitted_at: string | null;
  events: { name: string } | null; weight_classes: { name: string } | null;
  registration_documents: { id: string; kind: string; storage_path: string; mime_type: string; review_status: string }[];
}
interface Fighter {
  id: string; org_id: string; fighter_code: string; fight_name: string; nickname: string | null; division: string; competition_level: string;
  primary_style: string | null; skill_level: string | null; height_cm: number | null; reach_cm: number | null; hometown: string | null; country: string | null;
  bio: string | null; photo_path: string | null; public_photo_path: string | null; public_profile_approved: boolean; status: string; merged_into: string | null;
  registered_at: string; gyms: { id: string; name: string } | null;
  fighter_private: { legal_name: string; date_of_birth: string; email: string; phone_country_code: string | null; phone: string | null; city: string | null; country: string | null; mma_experience_years: number | null; previous_experience: string | null; coach_name_declared: string | null; consent_at: string } | null;
  fighter_records: Rec[];
  event_registrations: Reg[];
}

export function FighterDetail() {
  const { fighterId } = useParams();
  const { access } = useAuth();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const q = useAsync(async () => {
    const f = must(
      await supabase
        .from('fighters')
        .select(`*, gyms(id, name), fighter_private(*), fighter_records(*),
                 event_registrations(*, events(name), weight_classes(name), registration_documents(id, kind, storage_path, mime_type, review_status))`)
        .eq('id', fighterId)
        .single(),
    ) as unknown as Fighter;
    const bouts = must(
      await supabase.from('bouts').select('id, bout_code, status, event_id, fighter_a_id, fighter_b_id, events(name)').or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`).order('created_at', { ascending: false }),
    ) as unknown as { id: string; bout_code: string; status: BoutStatus; event_id: string; fighter_a_id: string; fighter_b_id: string; events: { name: string } | null }[];
    const flags = isOrgAdmin(access)
      ? (must(await supabase.from('fighter_duplicate_flags').select('id, candidate_fighter_id, fighter_id, match_reason, resolution').or(`fighter_id.eq.${fighterId},candidate_fighter_id.eq.${fighterId}`)) as { id: string; candidate_fighter_id: string; fighter_id: string; match_reason: string; resolution: string | null }[])
      : [];
    const coaches = must(await supabase.from('coach_fighters').select('id, status, coaches(full_name, email)').eq('fighter_id', fighterId)) as unknown as { id: string; status: string; coaches: { full_name: string; email: string } | null }[];
    return { f, bouts, flags, coaches };
  }, [fighterId]);

  const done = (text: string, error?: unknown) => {
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text });
    if (!error) void q.reload();
  };

  return (
    <Loading loading={q.loading} error={q.error}>
      {q.data && (
        <div className="flex flex-col gap-6">
          <div>
            <Link to="/admin/fighters" className="text-sm text-ink-400 hover:text-ink-100">
              ← Fighters
            </Link>
            <PageHeader
              title={q.data.f.fight_name}
              description={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink-100">{q.data.f.fighter_code}</span>
                  <Badge tone={q.data.f.status === 'active' ? 'ok' : 'neutral'}>{q.data.f.status}</Badge>
                  {q.data.f.merged_into && (
                    <Link to={`/admin/fighters/${q.data.f.merged_into}`} className="text-accent-400 underline">
                      Merged — open kept profile
                    </Link>
                  )}
                  <span>Registered {formatDateTime(q.data.f.registered_at)}</span>
                </span>
              }
              actions={
                <Button variant="secondary" onClick={async () => {
                  const { error } = await supabase.rpc('resend_fighter_confirmation', { p_fighter: q.data!.f.id });
                  done('Fighter ID email queued.', error);
                }}>
                  Resend fighter ID email
                </Button>
              }
            />
          </div>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <Registrations regs={q.data.f.event_registrations} onDone={done} />
          <div className="grid gap-6 xl:grid-cols-2">
            <PublicProfile f={q.data.f} onDone={done} />
            <PrivateInfo f={q.data.f} onDone={done} />
          </div>
          <Records f={q.data.f} onDone={done} />
          <Section title="Bouts">
            {q.data.bouts.length ? (
              <ul className="divide-y divide-ink-700">
                {q.data.bouts.map((b) => (
                  <li key={b.id} className="flex items-center justify-between py-2">
                    <Link to={`/admin/bouts?event=${b.event_id}&bout=${b.id}`} className="hover:underline">
                      {b.bout_code} · {b.events?.name}
                    </Link>
                    <BoutStatusBadge status={b.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-400">No bouts.</p>
            )}
          </Section>
          <Section title="Coaches">
            {q.data.coaches.length ? (
              <ul className="divide-y divide-ink-700">
                {q.data.coaches.map((c) => (
                  <li key={c.id} className="flex items-center justify-between py-2">
                    <span>
                      {c.coaches?.full_name} <span className="text-ink-400">{c.coaches?.email}</span>
                    </span>
                    <Badge tone={c.status === 'approved' ? 'ok' : c.status === 'pending' ? 'warn' : 'neutral'}>{c.status}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-400">Declared coach: {q.data.f.fighter_private?.coach_name_declared ?? '—'}</p>
            )}
          </Section>
          {isOrgAdmin(access) && <Duplicates fighter={q.data.f} flags={q.data.flags} onDone={done} />}
        </div>
      )}
    </Loading>
  );
}

function Registrations({ regs, onDone }: { regs: Reg[]; onDone: (t: string, e?: unknown) => void }) {
  const [review, setReview] = useState<{ reg: Reg; status: RegistrationStatus } | null>(null);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitReview() {
    if (!review) return;
    setBusy(true);
    const items = missing.split(',').map((s) => s.trim()).filter(Boolean);
    const { error } = await supabase.rpc('review_registration', {
      p_registration: review.reg.id, p_status: review.status, p_reason: reason || null, p_missing_info: review.status === 'incomplete' ? items : null,
    });
    setBusy(false);
    onDone(`Registration marked ${humanize(review.status)}. The fighter is notified by email where applicable.`, error);
    if (!error) {
      setReview(null);
      setReason('');
      setMissing('');
    }
  }
  async function patch(id: string, values: Record<string, unknown>, text: string) {
    const { error } = await supabase.from('event_registrations').update(values).eq('id', id);
    onDone(text, error);
  }
  async function openDoc(path: string) {
    const { data, error } = await supabase.storage.from('registration-private').createSignedUrl(path, 120);
    if (error || !data) onDone('', error ?? new Error('Could not open file'));
    else window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  const actions: Record<RegistrationStatus, RegistrationStatus[]> = {
    draft: [], submitted: ['approved', 'under_review', 'incomplete', 'rejected'], under_review: ['approved', 'incomplete', 'rejected'],
    incomplete: ['under_review', 'rejected'], approved: ['under_review'], rejected: ['under_review'],
  };

  return (
    <Section title="Event registrations">
      {regs.length === 0 && <p className="text-ink-400">No event registrations (profile only).</p>}
      <div className="flex flex-col gap-4">
        {regs.map((r) => (
          <div key={r.id} className="rounded-md border border-ink-700 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{r.events?.name}</span>
                <RegistrationStatusBadge status={r.status} />
                <span className="text-xs text-ink-400">via {r.submitted_via} · {formatDateTime(r.submitted_at)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {actions[r.status].map((s) => (
                  <Button key={s} variant={s === 'approved' ? 'primary' : s === 'rejected' ? 'danger' : 'secondary'} onClick={() => setReview({ reg: r, status: s })}>
                    {s === 'approved' ? 'Approve' : s === 'rejected' ? 'Reject' : s === 'incomplete' ? 'Request info' : 'Mark under review'}
                  </Button>
                ))}
              </div>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-4">
              <KeyValue items={[['Declared weight', formatWeight(r.declared_weight_g)], ['Weighed', formatDate(r.weight_recorded_at)]]} />
              <KeyValue items={[['Division', humanize(r.division)], ['Level', humanize(r.competition_level)]]} />
              <KeyValue items={[['Preferred class', r.weight_classes?.name ?? '—'], ['Available', r.is_available ? 'Yes' : `No${r.availability_notes ? ` — ${r.availability_notes}` : ''}`]]} />
              <div className="flex flex-col gap-3">
                <Field label="Clearance">
                  {({ id }) => (
                    <Select id={id} value={r.clearance_status} onChange={(e) => void patch(r.id, { clearance_status: e.target.value }, 'Clearance updated.')}>
                      {['not_required', 'pending', 'cleared', 'not_cleared'].map((s) => (
                        <option key={s} value={s}>
                          {humanize(s)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const kg = Number(new FormData(e.currentTarget).get('kg'));
                    if (kg > 30 && kg < 200) void patch(r.id, { declared_weight_g: toGrams(kg, 'kg'), weight_unit_entered: 'kg', weight_recorded_at: new Date().toISOString() }, 'Weight updated.');
                  }}
                >
                  <Input name="kg" aria-label="New weight in kg" type="number" step="0.1" placeholder="New weight kg" />
                  <Button type="submit" variant="secondary">
                    Record
                  </Button>
                </form>
              </div>
            </div>
            {r.missing_info?.length > 0 && <p className="mt-3 text-sm text-amber-300">Waiting for: {r.missing_info.map(humanize).join(', ')}</p>}
            {r.rejection_reason && <p className="mt-3 text-sm text-accent-400">Rejected: {r.rejection_reason}</p>}
            {r.registration_documents.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {r.registration_documents.map((d) => (
                  <Button key={d.id} variant="secondary" onClick={() => void openDoc(d.storage_path)}>
                    View {humanize(d.kind)}
                  </Button>
                ))}
              </div>
            )}
            <form
              className="mt-3"
              onSubmit={(e) => {
                e.preventDefault();
                void patch(r.id, { review_notes: String(new FormData(e.currentTarget).get('notes') ?? '') }, 'Notes saved.');
              }}
            >
              <Field label="Internal notes (never shown to fighters)">
                {({ id }) => <Textarea id={id} name="notes" defaultValue={r.review_notes ?? ''} className="min-h-16" />}
              </Field>
              <Button type="submit" variant="ghost" className="mt-1">
                Save notes
              </Button>
            </form>
          </div>
        ))}
      </div>
      <Modal open={!!review} onClose={() => setReview(null)} title={review ? `${humanize(review.status)} registration` : ''}>
        <div className="flex flex-col gap-4">
          {review?.status === 'incomplete' && (
            <Field label="Missing items" required hint="Comma separated, e.g. profile_photo, id_proof">
              {({ id }) => <Input id={id} value={missing} onChange={(e) => setMissing(e.target.value)} />}
            </Field>
          )}
          <Field label="Reason / message" required={review?.status === 'rejected' || review?.status === 'incomplete' || review?.reg.status === 'approved' || review?.reg.status === 'rejected'} hint="Rejection reasons and requests are included in the email to the fighter.">
            {({ id }) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <Button onClick={() => void submitReview()} loading={busy}>
            Confirm
          </Button>
        </div>
      </Modal>
    </Section>
  );
}

function PublicProfile({ f, onDone }: { f: Fighter; onDone: (t: string, e?: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const num = (s: string) => (s ? Number(s) : null);
    const { error } = await supabase
      .from('fighters')
      .update({ fight_name: d.fight_name, nickname: d.nickname || null, primary_style: d.primary_style || null, skill_level: d.skill_level || null, height_cm: num(d.height_cm), reach_cm: num(d.reach_cm), hometown: d.hometown || null, country: d.country || null, bio: d.bio || null, division: d.division, competition_level: d.competition_level })
      .eq('id', f.id);
    onDone('Profile saved.', error);
  }
  // Only publishing an uploaded photo needs the server function (it copies the photo to public storage).
  // Everything else is a plain, permission-checked update, so it works without the server functions.
  async function setApproved(v: boolean) {
    const { error } = await supabase.from('fighters').update({ public_profile_approved: v }).eq('id', f.id);
    return error;
  }
  async function approve(v: boolean) {
    setBusy(true);
    try {
      const needsPhotoCopy = v ? !!f.photo_path : !!f.public_photo_path;
      if (!needsPhotoCopy) {
        const error = await setApproved(v);
        onDone(v ? 'Public profile approved.' : 'Public profile withdrawn.', error ?? undefined);
        return;
      }
      try {
        await callFunction('fighter-profile-approval', { fighter_id: f.id, approve: v });
        onDone(v ? 'Public profile approved.' : 'Public profile withdrawn.');
      } catch (e) {
        const err = e as { code?: string; status?: number };
        if (err.code !== 'network' && err.status !== 404) throw e;
        // Server functions not deployed: still approve/withdraw. Withdrawn profiles never show a photo.
        const error = await setApproved(v);
        onDone(
          v ? 'Public profile approved. The photo will appear once the server functions are deployed (docs/DEPLOYMENT.md, step 3).'
            : 'Public profile withdrawn — the photo is no longer shown anywhere.',
          error ?? undefined,
        );
      }
    } catch (e) {
      onDone('', e);
    } finally {
      setBusy(false);
    }
  }
  async function showPhoto() {
    if (!f.photo_path) return;
    const { data } = await supabase.storage.from('registration-private').createSignedUrl(f.photo_path, 120);
    setPreview(data?.signedUrl ?? null);
  }
  const pub = publicMediaUrl(f.public_photo_path);
  return (
    <Section
      title="Public profile"
      actions={
        <span className="flex items-center gap-2">
          <Badge tone={f.public_profile_approved ? 'ok' : 'warn'}>{f.public_profile_approved ? 'Approved' : 'Not approved'}</Badge>
          <Button variant="secondary" loading={busy} onClick={() => void approve(!f.public_profile_approved)}>
            {f.public_profile_approved ? 'Withdraw' : 'Approve'}
          </Button>
        </span>
      }
    >
      <div className="mb-4 flex items-center gap-4">
        {pub ? <img src={pub} alt="Public photo" className="h-20 w-20 rounded-full object-cover" /> : preview ? <img src={preview} alt="Uploaded photo (private)" className="h-20 w-20 rounded-full object-cover" /> : null}
        {f.photo_path && !pub && !preview && (
          <Button variant="ghost" onClick={() => void showPhoto()}>
            Preview uploaded photo
          </Button>
        )}
        {!f.photo_path && <span className="text-sm text-ink-400">No photo uploaded.</span>}
      </div>
      <form onSubmit={save} className="grid gap-3 md:grid-cols-2">
        {([['fight_name', 'Fight name'], ['nickname', 'Nickname'], ['primary_style', 'Style'], ['hometown', 'Hometown'], ['country', 'Country'], ['height_cm', 'Height cm'], ['reach_cm', 'Reach cm']] as const).map(([k, l]) => (
          <Field key={k} label={l}>{({ id }) => <Input id={id} name={k} defaultValue={(f[k] as string | number | null) ?? ''} />}</Field>
        ))}
        <Field label="Division">{({ id }) => <Select id={id} name="division" defaultValue={f.division}>{[...new Set([f.division, 'men', 'women'])].map((d) => <option key={d} value={d}>{humanize(d)}</option>)}</Select>}</Field>
        <Field label="Level">{({ id }) => <Select id={id} name="competition_level" defaultValue={f.competition_level}>{['amateur', 'semi_pro', 'professional'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>}</Field>
        <Field label="Skill">{({ id }) => <Select id={id} name="skill_level" defaultValue={f.skill_level ?? ''}><option value="">Unknown</option>{['novice', 'intermediate', 'advanced', 'elite'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>}</Field>
        <div className="md:col-span-2"><Field label="Bio">{({ id }) => <Textarea id={id} name="bio" defaultValue={f.bio ?? ''} />}</Field></div>
        <Button type="submit" className="self-start">Save profile</Button>
      </form>
    </Section>
  );
}

function PrivateInfo({ f, onDone }: { f: Fighter; onDone: (t: string, e?: unknown) => void }) {
  const p = f.fighter_private;
  if (!p) return null;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const { error } = await supabase
      .from('fighter_private')
      .update({ legal_name: d.legal_name, date_of_birth: d.date_of_birth, email: d.email.toLowerCase(), phone_country_code: d.phone_country_code || null, phone: d.phone || null, city: d.city || null, country: d.country || null })
      .eq('fighter_id', f.id);
    onDone('Private details saved.', error);
  }
  return (
    <Section title="Private details">
      <p className="mb-3 text-xs text-ink-400">Never shown publicly. Changes are audited (values redacted in the log). Consent given {formatDateTime(p.consent_at)}.</p>
      <form onSubmit={save} className="grid gap-3 md:grid-cols-2">
        {([['legal_name', 'Legal name', 'text'], ['date_of_birth', 'Date of birth', 'date'], ['email', 'Email', 'email'], ['phone_country_code', 'Code', 'text'], ['phone', 'Phone', 'tel'], ['city', 'City', 'text'], ['country', 'Country', 'text']] as const).map(([k, l, t]) => (
          <Field key={k} label={l}>{({ id }) => <Input id={id} name={k} type={t} defaultValue={(p[k] as string | null) ?? ''} />}</Field>
        ))}
        <KeyValue items={[['Experience', p.mma_experience_years != null ? `${p.mma_experience_years} years` : '—']]} />
        {p.previous_experience && <p className="text-sm text-ink-300 md:col-span-2">{p.previous_experience}</p>}
        <Button type="submit" className="self-start">Save details</Button>
      </form>
    </Section>
  );
}

function Records({ f, onDone }: { f: Fighter; onDone: (t: string, e?: unknown) => void }) {
  const { session } = useAuth();
  const self = f.fighter_records.find((r) => r.kind === 'self_reported');
  const verified = f.fighter_records.find((r) => r.kind === 'verified');
  async function save(kind: 'self_reported' | 'verified', e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const n = (k: string) => (d[k] === '' ? null : Number(d[k]));
    const row = {
      fighter_id: f.id, kind, wins: n('wins') ?? 0, losses: n('losses') ?? 0, draws: n('draws') ?? 0, no_contests: n('no_contests') ?? 0,
      ko_tko_wins: n('ko_tko_wins'), submission_wins: n('submission_wins'), decision_wins: n('decision_wins'), source_note: d.source_note || null,
      ...(kind === 'verified' ? { verified_by: session?.user.id, verified_at: nowIso() } : {}),
    };
    const { error } = await supabase.from('fighter_records').upsert(row, { onConflict: 'fighter_id,kind' });
    onDone(kind === 'verified' ? 'Verified record saved — it is now the record used publicly and in matchmaking.' : 'Self-reported record saved.', error);
  }
  const form = (kind: 'self_reported' | 'verified', r?: Rec) => (
    <form onSubmit={(e) => void save(kind, e)} className="grid grid-cols-4 gap-2">
      {(['wins', 'losses', 'draws', 'no_contests', 'ko_tko_wins', 'submission_wins', 'decision_wins'] as const).map((k) => (
        <Field key={k} label={humanize(k).replace('Ko tko', 'KO/TKO')}>{({ id }) => <Input id={id} name={k} type="number" min={0} defaultValue={r?.[k] ?? (k.endsWith('_wins') ? '' : 0)} />}</Field>
      ))}
      <div className="col-span-4"><Field label="Source / note">{({ id }) => <Input id={id} name="source_note" defaultValue={r?.source_note ?? ''} />}</Field></div>
      <Button type="submit" variant={kind === 'verified' ? 'primary' : 'secondary'} className="col-span-4 justify-self-start">
        {kind === 'verified' ? 'Save as verified' : 'Save'}
      </Button>
    </form>
  );
  return (
    <Section title="Fight record">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 font-semibold">Self-reported {self && <span className="text-ink-400">({recordText(self)})</span>}</h3>
          {form('self_reported', self)}
        </div>
        <div>
          <h3 className="mb-2 font-semibold">
            Verified {verified ? <span className="text-ink-400">({recordText(verified)}, {formatDate(verified.verified_at)})</span> : <Badge tone="warn">None</Badge>}
          </h3>
          {form('verified', verified ?? self)}
        </div>
      </div>
    </Section>
  );
}

function Duplicates({ fighter, flags, onDone }: { fighter: Fighter; flags: { id: string; candidate_fighter_id: string; fighter_id: string; match_reason: string; resolution: string | null }[]; onDone: (t: string, e?: unknown) => void }) {
  const navigate = useNavigate();
  const [mergeTarget, setMergeTarget] = useState('');
  const [reason, setReason] = useState('');
  const open = flags.filter((x) => !x.resolution);
  async function merge() {
    const other = mergeTarget.trim();
    if (!other) return;
    let otherId = other;
    if (/^[A-Z0-9]{2,8}-F-\d+$/i.test(other)) {
      const { data } = await supabase.from('fighters').select('id').eq('fighter_code', other.toUpperCase()).maybeSingle();
      otherId = data?.id ?? '';
    }
    if (!otherId) return onDone('', new Error('Fighter ID not found.'));
    if (!window.confirm(`Merge ${other} INTO ${fighter.fighter_code}? The other profile's ID will be retired permanently.`)) return;
    const { error } = await supabase.rpc('merge_fighters', { p_keep: fighter.id, p_drop: otherId, p_reason: reason });
    onDone('Profiles merged.', error);
    if (!error) navigate(`/admin/fighters/${fighter.id}`);
  }
  async function dismiss(id: string) {
    const { error } = await supabase.from('fighter_duplicate_flags').update({ resolution: 'not_duplicate' }).eq('id', id);
    onDone('Marked as not a duplicate.', error);
  }
  return (
    <Section title="Duplicates & merging">
      {open.length > 0 ? (
        <Table caption="Possible duplicates">
          <thead><tr><th>Possible duplicate</th><th>Reason</th><th /></tr></thead>
          <tbody>
            {open.map((x) => {
              const other = x.fighter_id === fighter.id ? x.candidate_fighter_id : x.fighter_id;
              return (
                <tr key={x.id}>
                  <td><Link className="underline" to={`/admin/fighters/${other}`}>Open profile</Link></td>
                  <td>{x.match_reason}</td>
                  <td className="flex gap-2">
                    <Button variant="secondary" onClick={() => setMergeTarget(other)}>Merge into this profile</Button>
                    <Button variant="ghost" onClick={() => void dismiss(x.id)}>Not a duplicate</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <p className="text-ink-400">No open duplicate flags.</p>
      )}
      <div className="mt-4 grid gap-2 md:grid-cols-[1fr_2fr_auto]">
        <Input aria-label="Duplicate fighter ID" placeholder="Duplicate fighter ID (e.g. WDS-F-0042)" value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)} />
        <Input aria-label="Merge reason" placeholder="Reason (required, recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button variant="danger" onClick={() => void merge()} disabled={!mergeTarget || reason.trim().length < 5}>Merge</Button>
      </div>
    </Section>
  );
}
