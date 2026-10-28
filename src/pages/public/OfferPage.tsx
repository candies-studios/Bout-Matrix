import { useState } from 'react';
import { useParams } from 'react-router';
import { supabase } from '@/lib/supabase';
import { useAsync } from '@/hooks/useAsync';
import { formatDateTime, formatWeight, recordText, TBA } from '@/lib/format';
import { Alert, Badge, Button, Card, Field, Input, Textarea } from '@/components/ui';
import { KeyValue } from '@/components/more';
import { Loading } from '@/components/Loading';
import { useEffect } from 'react';

/** Personal pages must never be indexed or leak their URL to other sites. */
function useNoIndex() {
  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    document.title = 'Bout offer';
    return () => m.remove();
  }, []);
}

interface OfferView {
  ok: boolean;
  code?: string;
  status: string;
  can_respond: boolean;
  expires_at: string;
  responded_at: string | null;
  fighter: { fight_name: string; fighter_code: string };
  terms: {
    bout_code: string;
    event_name: string;
    starts_at: string | null;
    timezone: string;
    venue_name: string | null;
    venue_city: string | null;
    weight_class: string | null;
    weight_limit_g: number | null;
    contracted_weight_g: number | null;
    rounds: number;
    round_minutes: number;
    rules_text: string | null;
    opponent: {
      fight_name: string;
      nickname: string | null;
      country: string | null;
      gym: string | null;
      primary_style: string | null;
      height_cm: number | null;
      reach_cm: number | null;
      declared_weight_g: number | null;
      record: { wins: number; losses: number; draws: number; no_contests: number; verified: boolean } | null;
    };
  };
}

const MESSAGES: Record<string, string> = {
  not_found: 'This offer link is not valid. Check that you used the full link you were sent most recently.',
  expired: 'This offer has expired.',
  revoked: 'This offer was withdrawn by the organisers while the bout is reviewed. They will contact you.',
  superseded: 'A newer offer replaced this one. Use the most recent link you were sent.',
  withdrawn: 'This offer was withdrawn.',
  already_responded: 'You have already responded to this offer.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  invalid: 'Something was wrong with that answer. Please try again.',
  login_failed: 'The fighter ID or password is not correct for this offer.',
  login_locked: 'Too many wrong attempts. This link is locked for an hour — please try again later.',
  not_open: 'This bout is no longer accepting responses.',
  accepted: 'You accepted this offer. The organisers will let you know once the bout is confirmed.',
  declined: 'You declined this offer.',
};

interface Login { fighterCode: string; password: string }

/** Fighters must log in (fighter ID + date of birth as DDMMYYYY) before the offer is shown. */
function OfferLogin({ onLogin, error, busy }: { onLogin: (l: Login) => void; error: string | null; busy: boolean }) {
  const [fighterCode, setFighterCode] = useState('');
  const [password, setPassword] = useState('');
  return (
    <Card className="mx-auto mt-6 max-w-md">
      <h1 className="text-3xl font-bold uppercase">Bout offer login</h1>
      <p className="mt-2 text-ink-300">This offer is private. Log in to see the details and respond.</p>
      {error && <div className="mt-4"><Alert>{error}</Alert></div>}
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onLogin({ fighterCode: fighterCode.trim().toUpperCase(), password: password.replace(/\D/g, '') });
        }}
      >
        <Field label="Login ID" required hint="Your fighter ID, e.g. WDS-F-0012">
          {({ id, describedBy }) => (
            <Input id={id} aria-describedby={describedBy} value={fighterCode} onChange={(e) => setFighterCode(e.target.value)}
                   autoComplete="username" autoCapitalize="characters" required />
          )}
        </Field>
        <Field label="Password" required hint="Your date of birth as DDMMYYYY, e.g. 10 March 1987 → 10031987">
          {({ id, describedBy }) => (
            <Input id={id} aria-describedby={describedBy} type="password" inputMode="numeric" value={password}
                   onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          )}
        </Field>
        <Button type="submit" loading={busy}>Log in</Button>
      </form>
    </Card>
  );
}

export function OfferPage() {
  const { offerToken } = useParams();
  useNoIndex();
  // Credentials live only in memory for this page view (never stored in the browser).
  const [login, setLogin] = useState<Login | null>(null);
  const q = useAsync(async () => {
    if (!login) return null;
    const { data, error } = await supabase.rpc('public_get_offer', { p_token: offerToken ?? '', p_fighter_code: login.fighterCode, p_password: login.password });
    if (error) throw error;
    return data as OfferView;
  }, [offerToken, login]);
  const [choice, setChoice] = useState<'accept' | 'decline' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; code?: string; response?: string } | null>(null);

  async function submit() {
    if (!choice || !login) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('public_respond_offer', {
        p_token: offerToken ?? '', p_response: choice, p_reason: reason || null, p_fighter_code: login.fighterCode, p_password: login.password,
      });
      if (error) throw error;
      setResult(data as { ok: boolean; code?: string; response?: string });
    } catch (e) {
      setResult({ ok: false, code: (e as { code?: string }).code });
    } finally {
      setBusy(false);
      setChoice(null);
    }
  }

  const loginCode = q.data && !q.data.ok && ['login_required', 'login_failed', 'login_locked'].includes(q.data.code ?? '') ? q.data.code! : null;
  if (!login || loginCode) {
    return (
      <div className="mx-auto max-w-2xl">
        <OfferLogin
          busy={q.loading}
          error={loginCode && loginCode !== 'login_required' ? MESSAGES[loginCode] : null}
          onLogin={(l) => setLogin({ ...l })}
        />
        <p className="mt-6 text-center text-xs text-ink-400">This page is personal to you. Do not share the link or your password.</p>
      </div>
    );
  }

  const o = q.data;
  return (
    <div className="mx-auto max-w-2xl">
      <Loading loading={q.loading} error={q.error}>
        {!o?.ok ? (
          <Alert>{MESSAGES[o?.code ?? 'not_found'] ?? MESSAGES.not_found}</Alert>
        ) : (
          <>
            <p className="text-sm uppercase tracking-wide text-ink-400">Bout offer for {o.fighter.fight_name} · {o.fighter.fighter_code}</p>
            <h1 className="mt-1 text-4xl font-bold uppercase">{o.terms.event_name}</h1>
            <div className="mt-2">
              <Badge tone={o.status === 'accepted' ? 'ok' : o.status === 'pending' ? 'info' : 'warn'}>{o.status}</Badge>
            </div>

            <Card className="mt-6">
              <h2 className="mb-4 text-xl font-semibold uppercase">Proposed bout</h2>
              <KeyValue
                items={[
                  ['Weight class', o.terms.weight_class ?? 'Catchweight'],
                  ['Contracted weight', o.terms.contracted_weight_g ? formatWeight(o.terms.contracted_weight_g) : o.terms.weight_limit_g ? `Class limit ${formatWeight(o.terms.weight_limit_g)}` : 'Not set'],
                  ['Format', `${o.terms.rounds} rounds × ${o.terms.round_minutes} minutes`],
                  ['Date', formatDateTime(o.terms.starts_at, o.terms.timezone)],
                  ['Venue', o.terms.venue_name ? [o.terms.venue_name, o.terms.venue_city].filter(Boolean).join(', ') : TBA],
                  ['Respond by', formatDateTime(o.expires_at)],
                ]}
              />
              {o.terms.rules_text && <p className="mt-4 whitespace-pre-line text-sm text-ink-300">{o.terms.rules_text}</p>}
            </Card>

            <Card className="mt-4">
              <h2 className="mb-4 text-xl font-semibold uppercase">Your opponent</h2>
              <p className="font-display text-3xl font-bold uppercase">{o.terms.opponent.fight_name}</p>
              {o.terms.opponent.nickname && <p className="italic text-ink-400">“{o.terms.opponent.nickname}”</p>}
              <div className="mt-4">
                <KeyValue
                  items={[
                    ['Record', o.terms.opponent.record ? `${recordText(o.terms.opponent.record)}${o.terms.opponent.record.verified ? '' : ' (self-reported)'}` : 'Not provided'],
                    ['Gym', o.terms.opponent.gym],
                    ['Style', o.terms.opponent.primary_style],
                    ['Declared weight', o.terms.opponent.declared_weight_g ? formatWeight(o.terms.opponent.declared_weight_g) : 'Not provided'],
                    ['Height / reach', [o.terms.opponent.height_cm && `${o.terms.opponent.height_cm} cm`, o.terms.opponent.reach_cm && `${o.terms.opponent.reach_cm} cm reach`].filter(Boolean).join(' · ') || '—'],
                    ['Country', o.terms.opponent.country],
                  ]}
                />
              </div>
            </Card>

            {result ? (
              <div className="mt-6">
                {result.ok ? (
                  <Alert tone="ok">
                    {result.response === 'accept'
                      ? 'Thank you — your acceptance is recorded. The bout is final only once the organisers confirm it; they will let you know.'
                      : 'Thank you — your decline is recorded. The organisers have been notified.'}
                  </Alert>
                ) : (
                  <Alert>{MESSAGES[result.code ?? ''] ?? 'Your response could not be recorded. Please reload the page.'}</Alert>
                )}
              </div>
            ) : o.can_respond ? (
              <Card className="mt-6">
                {!choice ? (
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <Button onClick={() => setChoice('accept')} className="sm:flex-1">
                      Accept bout
                    </Button>
                    <Button variant="danger" onClick={() => setChoice('decline')} className="sm:flex-1">
                      Decline
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    <p className="text-lg">
                      {choice === 'accept'
                        ? `Confirm that you accept this bout against ${o.terms.opponent.fight_name}?`
                        : 'Confirm that you decline this bout?'}{' '}
                      <span className="text-ink-400">You cannot change your answer afterwards.</span>
                    </p>
                    {choice === 'decline' && (
                      <Field label="Reason (optional)" hint="Shared with the organisers only.">
                        {({ id }) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />}
                      </Field>
                    )}
                    <div className="flex gap-3">
                      <Button onClick={() => void submit()} loading={busy} variant={choice === 'accept' ? 'primary' : 'danger'}>
                        {choice === 'accept' ? 'Yes, I accept' : 'Yes, decline'}
                      </Button>
                      <Button variant="ghost" onClick={() => setChoice(null)}>
                        Go back
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            ) : (
              <Alert tone="warn">{MESSAGES[o.status] ?? 'This offer can no longer be answered.'}</Alert>
            )}
            <p className="mt-6 text-xs text-ink-400">This page is personal to you. Do not share the link.</p>
          </>
        )}
      </Loading>
    </div>
  );
}
