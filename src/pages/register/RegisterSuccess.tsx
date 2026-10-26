import { Link, Navigate, useLocation } from 'react-router';
import { Card } from '@/components/ui';
import { CopyButton } from '@/components/more';

interface SuccessState {
  kind: 'fighter' | 'coach';
  status?: string;
  fighter_code?: string;
  event_name?: string | null;
  registration_status?: string | null;
  email?: string;
}

export function RegisterSuccess() {
  const s = useLocation().state as SuccessState | null;
  if (!s) return <Navigate to="/register" replace />;
  return (
    <div className="mx-auto max-w-xl text-center">
      <h1 className="text-4xl font-bold uppercase">
        {s.status === 'already_registered' ? 'Already registered' : 'Registration received'}
      </h1>
      {s.kind === 'fighter' && s.fighter_code && (
        <Card className="mt-6">
          <p className="text-sm uppercase tracking-wide text-ink-400">Your permanent fighter ID</p>
          <p className="mt-2 font-display text-5xl font-bold tracking-wider text-ink-100">{s.fighter_code}</p>
          <div className="mt-4 flex justify-center">
            <CopyButton text={s.fighter_code} label="Copy ID" />
          </div>
          <p className="mt-4 text-sm text-ink-400">
            {s.status === 'already_registered'
              ? `You were already registered${s.event_name ? ` for ${s.event_name}` : ''} (status: ${s.registration_status?.replace('_', ' ')}).`
              : s.status === 'reused'
                ? 'We matched your existing profile — no duplicate was created.'
                : 'Keep this ID. Use it with the same email and date of birth to register for future events.'}
          </p>
        </Card>
      )}
      <p className="mt-6 text-ink-300">
        {s.kind === 'coach'
          ? 'An administrator will verify your details. If approved you will receive an invitation to the coach portal.'
          : 'The organisers will review your registration.'}{' '}
        A confirmation email is on its way{s.email ? ` to ${s.email}` : ''} — it can take a few minutes.
      </p>
      <Link to="/events" className="mt-8 inline-block font-semibold text-accent-400 hover:underline">
        Browse events
      </Link>
    </div>
  );
}
