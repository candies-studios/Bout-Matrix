import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  COMPETITION_LEVELS, DIVISIONS, FighterRegistrationSchema, SKILL_LEVELS, fieldErrors,
} from '@domain/schemas.ts';
import { toGrams } from '@domain/weights.ts';
import { ApiError, callFunction, uploadRegistrationFile } from '@/lib/api';
import { formatDateTime, humanize, venueText } from '@/lib/format';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { Checkbox } from '@/components/more';
import { Loading } from '@/components/Loading';
import { Turnstile } from '@/components/Turnstile';
import { usePublicGyms, useRegistrationEvent } from './useRegistrationEvent';

type Form = Record<string, string>;
const OTHER = '__other__';

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-ink-700 bg-ink-900 p-5">
      <legend className="px-2 font-display text-xl font-bold uppercase">{legend}</legend>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

export function FighterRegistration() {
  const navigate = useNavigate();
  const ev = useRegistrationEvent();
  const gyms = usePublicGyms();
  const [submissionKey] = useState(() => crypto.randomUUID());
  const [returning, setReturning] = useState(false);
  const [f, setF] = useState<Form>({ phone_country_code: '+91', weight_unit: 'kg', wins: '0', losses: '0', draws: '0', no_contests: '0', country: 'India' });
  const [consentData, setConsentData] = useState(false);
  const [consentRules, setConsentRules] = useState(false);
  const [available, setAvailable] = useState(true);
  const [photo, setPhoto] = useState<File | null>(null);
  const [docs, setDocs] = useState<Record<string, File | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captcha, setCaptcha] = useState('');

  const set = (k: string) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const event = ev.data;
  const divisions = event?.divisions?.length ? event.divisions : [...DIVISIONS];
  const levels = event?.competition_levels?.length ? event.competition_levels : [...COMPETITION_LEVELS];
  const classes = (event?.weight_classes ?? []).filter((w) => !w.division || !f.division || w.division === f.division);

  function input(name: string, label: string, opts: { required?: boolean; type?: string; hint?: string; autoComplete?: string; inputMode?: 'numeric' | 'decimal' | 'tel' | 'email' } = {}) {
    return (
      <Field label={label} required={opts.required} hint={opts.hint} error={errors[name]}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            name={name}
            type={opts.type ?? 'text'}
            value={f[name] ?? ''}
            onChange={set(name)}
            autoComplete={opts.autoComplete}
            inputMode={opts.inputMode}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            required={opts.required}
          />
        )}
      </Field>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const values = {
      ...f,
      submission_key: submissionKey,
      event_slug: ev.slug ?? null,
      existing_fighter_code: returning ? f.existing_fighter_code : undefined,
      gym_id: f.gym_id && f.gym_id !== OTHER ? f.gym_id : undefined,
      gym_name: f.gym_id && f.gym_id !== OTHER ? undefined : f.gym_name,
      is_available: available,
      consent_data: consentData,
      consent_rules: consentRules,
      documents: [],
      website: (document.getElementById('website') as HTMLInputElement | null)?.value ?? '',
    };
    const missingDocs = (event?.required_documents ?? []).filter((k) => !docs[k]);
    const parsed = FighterRegistrationSchema.safeParse(values);
    const errs = parsed.success ? {} : fieldErrors(parsed.error);
    for (const k of missingDocs) errs[`doc_${k}`] = 'This document is required for this event.';
    if (photo && (!photo.type.startsWith('image/') || photo.size > 5 * 1024 * 1024)) errs.photo = 'Photo must be a JPG, PNG or WEBP image up to 5 MB.';
    setErrors(errs);
    if (Object.keys(errs).length || !parsed.success) {
      setFormError('Please correct the highlighted fields.');
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setSubmitting(true);
    try {
      const photoRef = photo ? await uploadRegistrationFile('profile_photo', photo) : null;
      const documents = [];
      for (const [kind, file] of Object.entries(docs)) {
        if (file) documents.push({ kind, ...(await uploadRegistrationFile(kind, file)) });
      }
      const res = await callFunction<{ status: string; fighter_code: string; event_name: string | null; registration_status: string | null }>(
        'register-fighter',
        { ...values, photo_path: photoRef?.path, documents, captcha_token: captcha || undefined },
      );
      navigate('/register/success', { state: { kind: 'fighter', ...res, email: parsed.data.email } });
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      setFormError(err instanceof Error ? err.message : 'Registration failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-4xl font-bold uppercase">Fighter registration</h1>
      <Loading loading={ev.loading} error={ev.error}>
        {ev.notFound ? (
          <Alert>This registration link is not valid. Check the link with the organisers.</Alert>
        ) : event && !event.registration_open ? (
          <Card className="mt-6">
            <h2 className="text-2xl font-bold uppercase">Registration closed</h2>
            <p className="mt-2 text-ink-400">Registration for {event.name} is not currently open.</p>
          </Card>
        ) : (
          <>
            {event && (
              <Card className="mt-4">
                <p className="text-sm uppercase tracking-wide text-ink-400">Registering for</p>
                <p className="font-display text-2xl font-bold uppercase">{event.name}</p>
                <p className="text-sm text-ink-400">
                  {formatDateTime(event.starts_at)} · {venueText(event)}
                  {event.registration_closes_at && ` · Closes ${formatDateTime(event.registration_closes_at)}`}
                </p>
              </Card>
            )}
            <p className="mt-4 text-sm text-ink-400">
              Fields marked <span className="text-accent-400">*</span> are required. We only use your details to organise events. Medical information is never collected here.
            </p>
            <form noValidate onSubmit={onSubmit} className="mt-6 flex flex-col gap-6">
              {formError && <Alert>{formError}</Alert>}

              <Card>
                <Checkbox
                  id="returning"
                  checked={returning}
                  onChange={setReturning}
                  label="I already have a fighter ID from a previous event"
                  description="Enter it with the same email and date of birth you used before — we will reuse your profile instead of creating a duplicate."
                />
                {returning && <div className="mt-4">{input('existing_fighter_code', 'Fighter ID', { required: true, hint: 'For example WDS-F-0001' })}</div>}
              </Card>

              <Fieldset legend="About you">
                {input('legal_name', 'Full legal name', { required: true, autoComplete: 'name' })}
                {input('fight_name', 'Public fight name', { required: true, hint: 'Shown on fight cards' })}
                {input('nickname', 'Nickname')}
                {input('date_of_birth', 'Date of birth', { required: true, type: 'date', autoComplete: 'bday' })}
                {input('email', 'Email', { required: true, type: 'email', autoComplete: 'email', inputMode: 'email' })}
                <div className="grid grid-cols-[6rem_1fr] gap-2">
                  {input('phone_country_code', 'Code', { required: true, inputMode: 'tel' })}
                  {input('phone', 'Phone', { required: true, type: 'tel', autoComplete: 'tel-national', inputMode: 'tel' })}
                </div>
                {input('city', 'City', { required: true, autoComplete: 'address-level2' })}
                {input('country', 'Country', { required: true, autoComplete: 'country-name' })}
              </Fieldset>

              <Fieldset legend="Competition">
                <Field label="Division" required error={errors.division}>
                  {({ id, describedBy, invalid }) => (
                    <Select id={id} value={f.division ?? ''} onChange={set('division')} aria-describedby={describedBy} aria-invalid={invalid}>
                      <option value="">Choose…</option>
                      {divisions.map((d) => (
                        <option key={d} value={d}>
                          {humanize(d)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Competition level" required error={errors.competition_level}>
                  {({ id, describedBy, invalid }) => (
                    <Select id={id} value={f.competition_level ?? ''} onChange={set('competition_level')} aria-describedby={describedBy} aria-invalid={invalid}>
                      <option value="">Choose…</option>
                      {levels.map((d) => (
                        <option key={d} value={d}>
                          {humanize(d)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="grid grid-cols-[1fr_6rem] gap-2">
                  {input('weight_value', 'Current weight', { required: true, type: 'number', inputMode: 'decimal' })}
                  <Field label="Unit">
                    {({ id }) => (
                      <Select id={id} value={f.weight_unit} onChange={set('weight_unit')}>
                        <option value="kg">kg</option>
                        <option value="lb">lb</option>
                      </Select>
                    )}
                  </Field>
                </div>
                {classes.length > 0 && (
                  <Field label="Preferred weight class" error={errors.preferred_weight_class_id} hint="Organisers make the final decision.">
                    {({ id, describedBy }) => (
                      <Select id={id} value={f.preferred_weight_class_id ?? ''} onChange={set('preferred_weight_class_id')} aria-describedby={describedBy}>
                        <option value="">Not sure</option>
                        {classes.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                            {w.division ? ` (${w.division})` : ''} — up to {(w.max_g / 1000).toFixed(1)} kg
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                {f.weight_value && Number(f.weight_value) > 0 && (
                  <p className="self-end text-sm text-ink-400" aria-live="polite">
                    ≈ {(toGrams(Number(f.weight_value), f.weight_unit as 'kg' | 'lb') / 1000).toFixed(1)} kg
                  </p>
                )}
                {input('height_cm', 'Height (cm)', { type: 'number', inputMode: 'decimal' })}
                {input('reach_cm', 'Reach (cm)', { type: 'number', inputMode: 'decimal' })}
                {input('primary_style', 'Primary fighting style', { hint: 'e.g. Wrestling, Muay Thai, BJJ' })}
                <Field label="Skill level">
                  {({ id }) => (
                    <Select id={id} value={f.skill_level ?? ''} onChange={set('skill_level')}>
                      <option value="">Prefer not to say</option>
                      {SKILL_LEVELS.map((s) => (
                        <option key={s} value={s}>
                          {humanize(s)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </Fieldset>

              <Fieldset legend="Record & experience">
                {input('mma_experience_years', 'Years training MMA', { type: 'number', inputMode: 'decimal' })}
                <div />
                {input('wins', 'Wins', { required: true, type: 'number', inputMode: 'numeric' })}
                {input('losses', 'Losses', { required: true, type: 'number', inputMode: 'numeric' })}
                {input('draws', 'Draws', { required: true, type: 'number', inputMode: 'numeric' })}
                {input('no_contests', 'No contests', { required: true, type: 'number', inputMode: 'numeric' })}
                {input('ko_tko_wins', 'Wins by KO/TKO', { type: 'number', inputMode: 'numeric' })}
                {input('submission_wins', 'Wins by submission', { type: 'number', inputMode: 'numeric' })}
                {input('decision_wins', 'Wins by decision', { type: 'number', inputMode: 'numeric' })}
                <div className="sm:col-span-2">
                  <Field label="Previous competition experience" error={errors.previous_experience}>
                    {({ id }) => <Textarea id={id} value={f.previous_experience ?? ''} onChange={set('previous_experience')} maxLength={2000} />}
                  </Field>
                </div>
                <p className="text-xs text-ink-400 sm:col-span-2">Records are verified by the organisers before they appear publicly.</p>
              </Fieldset>

              <Fieldset legend="Team">
                <Field label="Gym or academy" required error={errors.gym_name}>
                  {({ id, describedBy, invalid }) => (
                    <Select id={id} value={f.gym_id ?? ''} onChange={set('gym_id')} aria-describedby={describedBy} aria-invalid={invalid}>
                      <option value="">Choose…</option>
                      {(gyms.data ?? []).map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                          {g.city ? ` — ${g.city}` : ''}
                        </option>
                      ))}
                      <option value={OTHER}>My gym is not listed</option>
                    </Select>
                  )}
                </Field>
                {(f.gym_id === OTHER || !gyms.data?.length) && input('gym_name', 'Gym name', { required: true, hint: 'Write "Independent" if you have no gym' })}
                {input('coach_name', 'Coach')}
              </Fieldset>

              <Fieldset legend="Availability & photo">
                <div className="sm:col-span-2">
                  <Checkbox id="available" checked={available} onChange={setAvailable} label="I am available to compete at this event" />
                </div>
                {input('availability_notes', 'Availability notes')}
                <Field label="Profile photo" hint="JPG, PNG or WEBP up to 5 MB. Only shown publicly after approval." error={errors.photo}>
                  {({ id, describedBy, invalid }) => (
                    <Input id={id} type="file" accept="image/jpeg,image/png,image/webp" aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
                  )}
                </Field>
                {(event?.required_documents ?? []).map((k) => (
                  <Field key={k} label={humanize(k)} required hint="JPG, PNG, WEBP or PDF up to 10 MB" error={errors[`doc_${k}`]}>
                    {({ id, describedBy, invalid }) => (
                      <Input id={id} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => setDocs((d) => ({ ...d, [k]: e.target.files?.[0] ?? null }))} />
                    )}
                  </Field>
                ))}
              </Fieldset>

              <Card className="flex flex-col gap-4">
                <Checkbox
                  id="consent_data"
                  checked={consentData}
                  onChange={setConsentData}
                  label={<>I agree that my details are stored and used to organise events and matchmaking. Only my fight name, approved photo and verified record are ever shown publicly. <span className="text-accent-400">*</span></>}
                />
                {errors.consent_data && <p className="text-sm text-accent-400">{errors.consent_data}</p>}
                <Checkbox
                  id="consent_rules"
                  checked={consentRules}
                  onChange={setConsentRules}
                  label={<>I declare the information above is true and I will follow the event rules and the instructions of officials. <span className="text-accent-400">*</span></>}
                />
                {errors.consent_rules && <p className="text-sm text-accent-400">{errors.consent_rules}</p>}
                {/* Honeypot for bots — hidden from people and assistive technology. */}
                <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
                  <label htmlFor="website">Website</label>
                  <input id="website" name="website" tabIndex={-1} autoComplete="off" />
                </div>
                <Turnstile onToken={setCaptcha} />
                <Button type="submit" loading={submitting} className="sm:self-start">
                  Submit registration
                </Button>
                <p className="text-xs text-ink-400">
                  Coaches can also <Link className="underline" to={`/register/coach${ev.slug ? `?event=${ev.slug}` : ''}`}>register a team</Link>.
                </p>
              </Card>
            </form>
          </>
        )}
      </Loading>
    </div>
  );
}
