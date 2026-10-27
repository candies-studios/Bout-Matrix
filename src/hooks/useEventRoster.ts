import { supabase } from '@/lib/supabase';
import { must, useAsync } from './useAsync';

export interface Registrant { fighter_id: string; status: string; declared_weight_g: number | null; division: string; fighters: { fight_name: string; fighter_code: string } | null }
export interface WC { id: string; name: string; division: string | null; min_g: number | null; max_g: number }

export function useEventRoster(eventId: string) {
  return useAsync(async () => {
    if (!eventId) return { regs: [] as Registrant[], classes: [] as WC[] };
    const regs = must(await supabase.from('event_registrations').select('fighter_id, status, declared_weight_g, division, fighters(fight_name, fighter_code)').eq('event_id', eventId)) as unknown as Registrant[];
    const classes = must(await supabase.from('weight_classes').select('id, name, division, min_g, max_g').eq('event_id', eventId).eq('is_active', true).order('max_g')) as WC[];
    return { regs, classes };
  }, [eventId]);
}

