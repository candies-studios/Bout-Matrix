import { supabase } from '@/lib/supabase';
import { must, useAsync } from './useAsync';

export interface AdminEvent {
  id: string;
  name: string;
  slug: string;
  status: string;
  starts_at: string | null;
}

/** Events the signed-in user may manage or matchmake (RLS-scoped). */
export function useAdminEvents() {
  return useAsync(
    async () =>
      must(await supabase.from('events').select('id, name, slug, status, starts_at').order('starts_at', { ascending: false, nullsFirst: true })) as AdminEvent[],
    [],
  );
}
