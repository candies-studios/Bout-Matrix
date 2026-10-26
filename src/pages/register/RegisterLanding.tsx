import { Link, useSearchParams } from 'react-router';
import { Card } from '@/components/ui';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export function RegisterLanding() {
  const [params] = useSearchParams();
  const event = params.get('event');
  const qs = event ? `?event=${encodeURIComponent(event)}` : '';
  const [eventName, setEventName] = useState<string | null>(null);
  useEffect(() => {
    if (!event) return;
    void supabase.rpc('public_registration_event', { p_slug: event }).then(({ data }) => setEventName(data?.[0]?.name ?? null));
  }, [event]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-4xl font-bold uppercase">Register</h1>
      <p className="mt-2 text-ink-400">{eventName ? `Registration for ${eventName}.` : 'Choose how you want to register.'}</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {[
          { to: `/register/fighter${qs}`, title: 'Fighter', body: 'Create your fighter profile and receive a permanent fighter ID. Returning fighters can reuse their ID.' },
          { to: `/register/coach${qs}`, title: 'Coach or gym', body: 'Register as a coach and list your fighters. Verified coaches can manage their roster.' },
        ].map((c) => (
          <Link key={c.to} to={c.to} className="group">
            <Card className="h-full transition-colors group-hover:border-accent-600">
              <h2 className="text-2xl font-bold uppercase">{c.title}</h2>
              <p className="mt-2 text-ink-400">{c.body}</p>
              <span className="mt-4 inline-block font-semibold text-accent-400">Start →</span>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
