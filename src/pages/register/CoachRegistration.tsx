import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { CoachRegistrationSchema, fieldErrors } from '@domain/schemas.ts';
import { ApiError, callFunction } from '@/lib/api';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { Checkbox } from '@/components/more';
import { Loading } from '@/components/Loading';
import { Turnstile } from '@/components/Turnstile';
import { usePublicGyms, useRegistrationEvent } from './useRegistrationEvent';

const OTHER = '__other__';

export function CoachRegistration() {
  const navigate = useNavigate();
  const ev = useRegistrationEvent();
  const gyms = usePublicGyms();
  const [key] = useState(() => crypto.randomUUID());
  const [f, setF] = useState<Record<string, string>>({ phone_country_code: '+91', country: 'India', roster: '' });
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captcha, setCaptcha] = useState('');
  const set = (k: string) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const field = (name: string, label: string, required = false, type = 'text', hint?: string) => (
    <Field label={label} required={required} hint={hint} error={errors[name]}>
      {({ id, describedBy, invalid }) => <Input id={id} type={type} value={f[name] ?? ''} onChange={set(name)} aria-describedby={describedBy} aria-invalid={invalid} />}
    </Field>
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const values = {
      ...f,
      submission_key: key,
      event_slug: ev.slug ?? null,
      gym_id: f.gym_id && f.gym_id !== OTHER ? f.gym_id : undefined,
      gym_name: f.gym_id && f.gym_id !== OTHER ? undefined : f.gym_name,
      roster: f.roster.split('\n').map((s) => s.trim()).filter(Boolean),
      consent_data: consent,
      website: (document.getElementById('website') as HTMLInputElement | null)?.value ?? '',
    };
    const parsed = CoachRegistrationSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError('Please correct the highlighted fields.');
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await callFunction('register-coach', { ...values, captcha_token: captcha || undefined });
      navigate('/register/success', { state: { kind: 'coach', email: parsed.data.email } });
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      setFormError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-4xl font-bold uppercase">Coach & gym registration</h1>
      <Loading loading={ev.loading} error={ev.error}>
        {ev.notFound ? (
          <Alert>This registration link is not valid.</Alert>
        ) : ev.data && !ev.data.registration_open ? (
          <Alert tone="warn">Registration for {ev.data.name} is closed.</Alert>
        ) : (
          <form noValidate onSubmit={onSubmit} className="mt-6 flex flex-col gap-6">
            {ev.data && <p className="text-ink-400">Registering for <strong className="text-ink-100">{ev.data.name}</strong>.</p>}
            {formError && <Alert>{formError}</Alert>}
            <Card className="grid gap-4 sm:grid-cols-2">
              {field('full_name', 'Full name', true)}
              {field('email', 'Email', true, 'email')}
              <div className="grid grid-cols-[6rem_1fr] gap-2">
                {field('phone_country_code', 'Code', true)}
                {field('phone', 'Phone', true, 'tel')}
              </div>
              {field('coaching_experience_years', 'Years coaching', true, 'number')}
              <Field label="Gym or academy" required error={errors.gym_name}>
                {({ id, invalid }) => (
                  <Select id={id} value={f.gym_id ?? ''} onChange={set('gym_id')} aria-invalid={invalid}>
                    <option value="">Choose…</option>
                    {(gyms.data ?? []).map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                    <option value={OTHER}>My gym is not listed</option>
                  </Select>
                )}
              </Field>
              {(f.gym_id === OTHER || !gyms.data?.length) && field('gym_name', 'Gym name', true)}
              {field('city', 'City', true)}
              {field('country', 'Country', true)}
              <div className="sm:col-span-2">
                <Field label="Coaching experience" error={errors.experience_summary}>
                  {({ id }) => <Textarea id={id} value={f.experience_summary ?? ''} onChange={set('experience_summary')} />}
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Verification information" hint="Certifications, federation membership or a reference we can check." error={errors.verification_info}>
                  {({ id }) => <Textarea id={id} value={f.verification_info ?? ''} onChange={set('verification_info')} />}
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Fighter roster" hint="One fighter name per line. Each fighter still registers with their own details." error={errors.roster}>
                  {({ id }) => <Textarea id={id} value={f.roster} onChange={set('roster')} />}
                </Field>
              </div>
            </Card>
            <Card className="flex flex-col gap-4">
              <Checkbox id="consent" checked={consent} onChange={setConsent} label={<>I agree that these details are stored to verify me and organise events. <span className="text-accent-400">*</span></>} />
              {errors.consent_data && <p className="text-sm text-accent-400">{errors.consent_data}</p>}
              <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
                <label htmlFor="website">Website</label>
                <input id="website" name="website" tabIndex={-1} autoComplete="off" />
              </div>
              <Turnstile onToken={setCaptcha} />
              <Button type="submit" loading={submitting} className="sm:self-start">
                Submit registration
              </Button>
            </Card>
          </form>
        )}
      </Loading>
    </div>
  );
}
