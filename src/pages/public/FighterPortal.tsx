import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { supabase, friendlyError } from '@/lib/supabase';
import { useAsync } from '@/hooks/useAsync';
import { formatDateTime, formatWeight, humanize, recordText, TBA } from '@/lib/format';
import { Alert, Badge, Button, Card, Field, Input, Textarea } from '@/components/ui';
import { KeyValue } from '@/components/more';
import { Loading } from '@/components/Loading';

interface Opponent {
  fight_name: string; nickname: string | null; country: string | null; gym: string | null; primary_style: string | null;
  height_cm: number | null; reach_cm: number | null; declared_weight_g: number | null;
  record: { wins: number; losses: number; draws: number; no_contests: number; verified: boolean } | null;
}
interface PortalOffer {
  offer_id: string; status: string; can_respond: boolean; expires_at: string; responded_at: string | null;
  terms: {
    bout_code: string; event_name: string; starts_at: string | null; timezone: string; venue_name: string | null; venue_city: string | null;
    weight_class: string | null; weight_limit_g: number | null; contracted_weight_g: number | null; rounds: number; round_minutes: number;
    rules_text: string | null; opponent: Opponent;
  };
}
interface Portal {
  ok: boolean; code?: string;
  fighter: { fight_name: string; fighter_code: string; gym: string | null };
  offers: PortalOffer[];
  bouts: { bout_code: string; status: string; event_name: string; event_slug: string; starts_at: string | null; timezone: string; venue_name: string | null; venue_city: string | null; weight_class: string | null; rounds: number; round_minutes: number; opponent: string }[];
  registrations: { event_name: string; event_slug: string; starts_at: string | null; timezone: string; status: string; division: string; weight_g: number | null; missing_info: string[] }[];
}

const KEY = 'fighter-session';
const readSession = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
const writeSession = (v: string | null) => { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch { /* memory only */ } };

const LOGIN_ERRORS: Record<string, string> = {
  login_failed: 'Fighter ID or password is not correct. The password is your date of birth as DDMMYYYY.',
  login_locked: 'Too many wrong attempts for this fighter ID. Please try again in an hour.',
  rate_limited: 'Too many attempts from this connection. Please wait a few minutes.',
};
const OFFER_STATUS: Record<string, string> = {
  accepted: 'You accepted — the organisers will confirm the bout.',
  declined: 'You declined this bout.',
  expired: 'This offer expired.',
  withdrawn: 'This offer was withdrawn.',
  revoked: 'This offer was withdrawn while the bout is reviewed.',
  superseded: 'This offer was replaced by a newer one.',
};

/** Public fighter area: log in with fighter ID + date of birth (DDMMYYYY), then see and answer bout offers. */
export function FighterPortal() {
  const [session, setSession] = useState<string | null>(readSession);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => m.remove();
  }, []);

  const q = useAsync(async () => {
    if (!session) return null;
    const { data, error } = await supabase.rpc('public_fighter_portal', { p_session: session });
    if (error) throw error;
    return data as Portal;
  }, [session]);
  // A session that the server no longer accepts (expired / logged out elsewhere) shows the login form again.
  const sessionEnded = !!q.data && !q.data.ok;

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoginErr(null);
    const { data, error } = await supabase.rpc('public_fighter_login', { p_fighter_code: code.trim().toUpperCase(), p_password: password.replace(/\D/g, '') });
    setBusy(false);
    if (error) return setLoginErr(friendlyError(error));
    const r = data as { ok: boolean; code?: string; session?: string };
    if (!r.ok || !r.session) return setLoginErr(LOGIN_ERRORS[r.code ?? ''] ?? 'Login failed.');
    writeSession(r.session);
    setPassword('');
    setSession(r.session);
  }
  async function logout() {
    if (session) await supabase.rpc('public_fighter_logout', { p_session: session });
    writeSession(null);
    setSession(null);
  }

  if (!session || sessionEnded) {
    return (
      <div className="mx-auto max-w-md">
        <Card className="mt-2">
          <h1 className="text-3xl font-bold uppercase">Fighter login</h1>
          <p className="mt-2 text-ink-300">See your registrations and bout offers, and accept or decline bouts.</p>
          {(loginErr || sessionEnded) && <div className="mt-4"><Alert>{loginErr ?? 'Your session ended. Please log in again.'}</Alert></div>}
          <form className="mt-4 flex flex-col gap-4" onSubmit={(e) => void login(e)}>
            <Field label="Login ID" required hint="Your fighter ID, e.g. WDS-F-0012 (on your registration confirmation)">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="username" autoCapitalize="characters" required />}
            </Field>
            <Field label="Password" required hint="Your date of birth as DDMMYYYY, e.g. 10 March 1987 → 10031987">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="password" inputMode="numeric" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
            </Field>
            <Button type="submit" loading={busy}>Log in</Button>
          </form>
          <p className="mt-4 text-sm text-ink-400">Not registered yet? <Link to="/register" className="text-accent-400 hover:underline">Register for an event</Link></p>
        </Card>
      </div>
    );
  }

  const p = q.data;
  const open = p?.offers.filter((o) => o.can_respond) ?? [];
  const past = p?.offers.filter((o) => !o.can_respond) ?? [];
  return (
    <div className="mx-auto max-w-3xl">
      <Loading loading={q.loading && !p} error={q.error}>
        {p?.ok && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-sm uppercase tracking-wide text-ink-400">Fighter area</p>
                <h1 className="text-4xl font-bold uppercase">{p.fighter.fight_name}</h1>
                <p className="text-ink-300">{p.fighter.fighter_code}{p.fighter.gym ? ` · ${p.fighter.gym}` : ''}</p>
              </div>
              <Button variant="secondary" onClick={() => void logout()}>Log out</Button>
            </div>

            <section>
              <h2 className="mb-3 text-2xl font-semibold uppercase">Bout offers {open.length > 0 && <Badge tone="info">{open.length} waiting for you</Badge>}</h2>
              {open.length === 0 && <p className="text-ink-400">No bout offers waiting for an answer. When the organisers offer you a bout it appears here.</p>}
              <div className="flex flex-col gap-4">
                {open.map((o) => <OfferCard key={o.offer_id} o={o} session={session} onDone={() => void q.reload()} />)}
              </div>
              {past.length > 0 && (
                <ul className="mt-4 flex flex-col gap-2 text-sm">
                  {past.map((o) => (
                    <li key={o.offer_id} className="rounded-md border border-ink-700 px-3 py-2">
                      <strong>{o.terms.event_name}</strong> vs {o.terms.opponent.fight_name} — <span className="text-ink-300">{OFFER_STATUS[o.status] ?? humanize(o.status)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {p.bouts.length > 0 && (
              <section>
                <h2 className="mb-3 text-2xl font-semibold uppercase">Confirmed bouts</h2>
                <ul className="flex flex-col gap-2">
                  {p.bouts.map((b) => (
                    <li key={b.bout_code}><Card className="p-4">
                      <p className="font-display text-xl font-bold uppercase">vs {b.opponent}</p>
                      <p className="text-sm text-ink-300">{b.event_name} · {b.weight_class ?? 'Catchweight'} · {b.rounds} × {b.round_minutes} min</p>
                      <p className="text-sm text-ink-400">{formatDateTime(b.starts_at, b.timezone)} · {b.venue_name ? [b.venue_name, b.venue_city].filter(Boolean).join(', ') : TBA}</p>
                    </Card></li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h2 className="mb-3 text-2xl font-semibold uppercase">My registrations</h2>
              {p.registrations.length === 0 ? <p className="text-ink-400">No registrations yet.</p> : (
                <ul className="flex flex-col gap-2">
                  {p.registrations.map((r) => (
                    <li key={r.event_slug} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-700 px-3 py-2">
                      <span><Link to={`/events/${r.event_slug}`} className="font-semibold hover:underline">{r.event_name}</Link>
                        <span className="ml-2 text-sm text-ink-400">{humanize(r.division)}{r.weight_g ? ` · ${formatWeight(r.weight_g)}` : ''}</span></span>
                      <Badge tone={r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'danger' : 'info'}>{humanize(r.status)}</Badge>
                      {r.status === 'incomplete' && r.missing_info.length > 0 && <p className="w-full text-sm text-amber-300">Please send the organisers: {r.missing_info.map(humanize).join(', ')}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Loading>
    </div>
  );
}

function OfferCard({ o, session, onDone }: { o: PortalOffer; session: string; onDone: () => void }) {
  const [choice, setChoice] = useState<'accept' | 'decline' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = o.terms;
  async function submit() {
    if (!choice) return;
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.rpc('public_fighter_respond', { p_session: session, p_offer: o.offer_id, p_response: choice, p_reason: reason || null });
    setBusy(false);
    const r = data as { ok: boolean; code?: string } | null;
    if (error || !r?.ok) return setErr(error ? friendlyError(error) : r?.code === 'expired' ? 'This offer has expired.' : 'Your answer could not be saved. Please reload the page.');
    onDone();
  }
  return (
    <Card>
      <p className="text-sm uppercase tracking-wide text-ink-400">{t.event_name} · respond by {formatDateTime(o.expires_at)}</p>
      <p className="mt-1 font-display text-3xl font-bold uppercase">vs {t.opponent.fight_name}</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <KeyValue items={[
          ['Weight class', t.weight_class ?? 'Catchweight'],
          ['Weight', t.contracted_weight_g ? formatWeight(t.contracted_weight_g) : t.weight_limit_g ? `Class limit ${formatWeight(t.weight_limit_g)}` : 'Not set'],
          ['Format', `${t.rounds} rounds × ${t.round_minutes} minutes`],
          ['Date', formatDateTime(t.starts_at, t.timezone)],
          ['Venue', t.venue_name ? [t.venue_name, t.venue_city].filter(Boolean).join(', ') : TBA],
        ]} />
        <KeyValue items={[
          ['Opponent record', t.opponent.record ? `${recordText(t.opponent.record)}${t.opponent.record.verified ? '' : ' (self-reported)'}` : 'Not provided'],
          ['Gym', t.opponent.gym],
          ['Declared weight', t.opponent.declared_weight_g ? formatWeight(t.opponent.declared_weight_g) : 'Not provided'],
          ['Country', t.opponent.country],
        ]} />
      </div>
      {t.rules_text && <p className="mt-3 whitespace-pre-line text-sm text-ink-300">{t.rules_text}</p>}
      {err && <div className="mt-3"><Alert>{err}</Alert></div>}
      <div className="mt-4">
        {!choice ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={() => setChoice('accept')} className="sm:flex-1">Accept bout</Button>
            <Button variant="danger" onClick={() => setChoice('decline')} className="sm:flex-1">Decline</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p>{choice === 'accept' ? `Accept this bout against ${t.opponent.fight_name}?` : 'Decline this bout?'} <span className="text-ink-400">You cannot change your answer afterwards.</span></p>
            {choice === 'decline' && (
              <Field label="Reason (optional)" hint="Shared with the organisers only.">
                {({ id }) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />}
              </Field>
            )}
            <div className="flex gap-3">
              <Button onClick={() => void submit()} loading={busy} variant={choice === 'accept' ? 'primary' : 'danger'}>{choice === 'accept' ? 'Yes, I accept' : 'Yes, decline'}</Button>
              <Button variant="ghost" onClick={() => setChoice(null)}>Go back</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
