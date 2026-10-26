import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useAdminEvents } from './useEvents';

/** Event selector bound to ?event= so links and reloads keep the context. */
export function useSelectedEvent() {
  const [params, setParams] = useSearchParams();
  const events = useAdminEvents();
  const eventId = params.get('event') ?? '';
  useEffect(() => {
    if (!eventId && events.data?.length) {
      const next = new URLSearchParams(params);
      next.set('event', events.data[0].id);
      setParams(next, { replace: true });
    }
  }, [eventId, events.data, params, setParams]);
  const setEventId = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('event', id);
    setParams(next);
  };
  return { eventId, setEventId, events: events.data ?? [], loading: events.loading };
}

