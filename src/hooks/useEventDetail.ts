import { supabase } from '@/lib/supabase';
import { useAsync } from './useAsync';

export interface EventDetail {
  slug: string;
  name: string;
  promotion: string | null;
  description: string | null;
  starts_at: string | null;
  timezone: string;
  venue_name: string | null;
  venue_address: string | null;
  venue_city: string | null;
  venue_country: string | null;
  status: string;
  registration_open: boolean;
  registration_closes_at: string | null;
  fight_card_published: boolean;
  rules_text: string | null;
  weight_classes: { id: string; name: string; division: string | null; max_g: number }[];
}

export function useEventDetail(slug: string | undefined) {
  return useAsync(async () => {
    const { data, error } = await supabase.rpc('public_get_event', { p_slug: slug });
    if (error) throw error;
    return ((data as EventDetail[])[0] ?? null) as EventDetail | null;
  }, [slug]);
}

