import type { Candidate } from './domain/matchmaking.ts';

/** Shape returned by public.svc_matchmaking_pool. */
export interface Pool {
  event: { id: string; starts_at: string | null; eligibility: Record<string, unknown> };
  rules: Record<string, unknown>;
  weight_classes: { id: string; name: string; division: string | null; min_g: number | null; max_g: number; allowed_diff_g: number }[];
  candidates: Candidate[];
}
