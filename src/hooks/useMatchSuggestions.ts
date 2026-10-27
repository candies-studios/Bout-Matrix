import { useEffect } from 'react';
import type { Classification, Evaluation } from '@domain/matchmaking.ts';
import { supabase } from '@/lib/supabase';
import { useAsync } from './useAsync';

export interface SuggestionSide {
  fight_name: string;
  fighter_code: string;
  weight_g: number | null;
  division: string;
}
export interface MatchSuggestion {
  id: string;
  fighter_a_id: string;
  fighter_b_id: string;
  score: number | null;
  classification: Classification;
  evaluation: Evaluation;
  fighter_a: SuggestionSide;
  fighter_b: SuggestionSide;
}
export interface MatchSuggestions {
  refreshed_at: string | null;
  stats: { registrants: number; approved: number; ready: number; awaiting_review: number };
  suggestions: MatchSuggestion[];
}

/**
 * Suggestions are computed in the database and refreshed automatically whenever registrations,
 * weights, records, rules or bouts change. This hook re-reads them every minute and whenever the
 * tab regains focus, so the page stays current without any "generate" button.
 */
export function useMatchSuggestions(eventId: string) {
  const q = useAsync(async () => {
    if (!eventId) return null;
    const { data, error } = await supabase.rpc('get_match_suggestions', { p_event: eventId });
    if (error) throw error;
    return data as MatchSuggestions;
  }, [eventId]);
  const { reload } = q;
  useEffect(() => {
    if (!eventId) return;
    const timer = setInterval(() => void reload(), 60_000);
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [eventId, reload]);
  return q;
}
