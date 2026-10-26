import { useState, type FormEvent } from 'react';
import { supabase, friendlyError } from '@/lib/supabase';
import { Alert, Button, Field, Input } from './ui';

/** Set or change the signed-in user's password (used after accepting an invitation). */
export function PasswordForm() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (pw.length < 12) return setMsg({ tone: 'danger', text: 'Use at least 12 characters.' });
    if (pw !== pw2) return setMsg({ tone: 'danger', text: 'Passwords do not match.' });
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    setMsg(error ? { tone: 'danger', text: friendlyError(error) } : { tone: 'ok', text: 'Password saved.' });
    if (!error) {
      setPw('');
      setPw2('');
    }
  }
  return (
    <form onSubmit={save} className="flex max-w-sm flex-col gap-3">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Field label="New password" hint="At least 12 characters.">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
      <Field label="Repeat password">{({ id }) => <Input id={id} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
      <Button type="submit" loading={busy} className="self-start">Save password</Button>
    </form>
  );
}
