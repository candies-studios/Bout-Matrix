import { useSearchParams } from 'react-router';
import { supabase } from '@/lib/supabase';
import { useAsync } from '@/hooks/useAsync';

export interface RegistrationEvent {
  slug: string;
  name: string;
  starts_at: string | null;
  venue_name: string | null;
  venue_city: string | null;
  registration_open: boolean;
  registration_closes_at: string | null;
  divisions: string[];
  competition_levels: string[];
  required_documents: string[];
  weight_classes: { id: string; name: string; division: string | null; min_g: number | null; max_g: number }[];
}

export function useRegistrationEvent() {
  const [params] = useSearchParams();
  const slug = params.get('event');
  const q = useAsync(async () => {
    if (!slug) return null;
    const { data, error } = await supabase.rpc('public_registration_event', { p_slug: slug });
    if (error) throw error;
    return ((data as RegistrationEvent[])[0] ?? null) as RegistrationEvent | null;
  }, [slug]);
  return { slug, ...q, notFound: Boolean(slug) && !q.loading && !q.error && !q.data };
}

export function usePublicGyms() {
  return useAsync(async () => {
    const { data, error } = await supabase.rpc('public_list_gyms');
    if (error) throw error;
    return data as { id: string; name: string; city: string | null }[];
  }, []);
}
