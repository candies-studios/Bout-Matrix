import { useCallback, useEffect, useRef, useState } from 'react';
import { friendlyError } from '@/lib/supabase';

/** Run an async loader; exposes data/error/loading and a reload function. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const v = await run();
      if (id === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(friendlyError(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Throw on Supabase errors so useAsync can surface them. */
export function must<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data as T;
}
