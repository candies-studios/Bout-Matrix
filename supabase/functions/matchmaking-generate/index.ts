// POST /functions/v1/matchmaking-generate — { event_id } regenerate suggestions, or
// { event_id, fighter_a_id, fighter_b_id } evaluate one pairing (comparison screen).
import { z } from 'zod';
import { evaluatePair, generateSuggestions } from '../_shared/domain/matchmaking.ts';
import type { Pool } from '../_shared/pool.ts';
import { adminClient, HttpError, json, readJson, requireUser, serve } from '../_shared/http.ts';

const Body = z.object({ event_id: z.uuid(), fighter_a_id: z.uuid().optional(), fighter_b_id: z.uuid().optional() });

serve(async (req) => {
  const uid = await requireUser(req);
  const b = Body.safeParse(await readJson(req));
  if (!b.success) throw new HttpError(400, 'invalid', 'event_id is required.');
  const db = adminClient();
  const { data, error } = await db.rpc('svc_matchmaking_pool', { p_actor: uid, p_event: b.data.event_id });
  if (error) throw error;
  const pool = data as Pool;
  const names = Object.fromEntries(pool.candidates.map((c) => [c.fighter_id, { fight_name: c.fight_name, fighter_code: c.fighter_code, weight_g: c.weight_g, gym_name: c.gym_name, record: c.record }]));

  if (b.data.fighter_a_id && b.data.fighter_b_id) {
    const a = pool.candidates.find((c) => c.fighter_id === b.data.fighter_a_id);
    const c = pool.candidates.find((c) => c.fighter_id === b.data.fighter_b_id);
    if (!a || !c) throw new HttpError(404, 'not_found', 'Both fighters must be registered for this event.');
    return json(req, { evaluation: evaluatePair(a, c, pool.event, pool.rules, pool.weight_classes), fighters: names });
  }

  const suggestions = generateSuggestions(pool.candidates, pool.event, pool.rules, pool.weight_classes, { limit: 300 });
  const rows = suggestions.map((s) => ({ fighter_a_id: s.fighter_a_id, fighter_b_id: s.fighter_b_id, score: s.score, classification: s.classification, evaluation: s }));
  const { error: e2 } = await db.rpc('svc_store_suggestions', { p_actor: uid, p_event: b.data.event_id, p_rules: pool.rules, p_rows: rows });
  if (e2) throw e2;
  return json(req, { count: rows.length, candidates: pool.candidates.length });
});
