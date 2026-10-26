// POST /functions/v1/bout-create — creates a draft bout after re-evaluating the pairing on the server.
// The browser never supplies the evaluation; overrides require a written reason (enforced in SQL too).
import { z } from 'zod';
import { evaluatePair } from '../_shared/domain/matchmaking.ts';
import { adminClient, HttpError, json, readJson, requireUser, serve } from '../_shared/http.ts';
import type { Pool } from '../_shared/pool.ts';

const Body = z.object({
  event_id: z.uuid(),
  fighter_a_id: z.uuid(),
  fighter_b_id: z.uuid(),
  weight_class_id: z.uuid().optional().nullable(),
  contracted_weight_g: z.number().int().min(30000).max(200000).optional().nullable(),
  rounds: z.number().int().min(1).max(5).optional(),
  round_minutes: z.number().int().min(1).max(10).optional(),
  rules_text: z.string().max(4000).optional(),
  override_reason: z.string().trim().max(2000).optional(),
  suggestion_id: z.uuid().optional().nullable(),
  replaces_bout_id: z.uuid().optional().nullable(),
  admin_notes: z.string().max(4000).optional(),
});

serve(async (req) => {
  const uid = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid', parsed.error.issues[0]?.message ?? 'Invalid request.');
  const p = parsed.data;
  if (p.fighter_a_id === p.fighter_b_id) throw new HttpError(400, 'invalid', 'Choose two different fighters.');
  const db = adminClient();

  const { data, error } = await db.rpc('svc_matchmaking_pool', { p_actor: uid, p_event: p.event_id });
  if (error) throw error;
  const pool = data as Pool;
  let a = pool.candidates.find((c) => c.fighter_id === p.fighter_a_id);
  let b = pool.candidates.find((c) => c.fighter_id === p.fighter_b_id);
  if (!a || !b) throw new HttpError(409, 'ineligible', 'Both fighters must be registered for this event.');

  // When replacing a bout, its fighters are released in the same transaction.
  if (p.replaces_bout_id) {
    const { data: old } = await db.from('bouts').select('fighter_a_id, fighter_b_id, event_id').eq('id', p.replaces_bout_id).maybeSingle();
    if (!old || old.event_id !== p.event_id) throw new HttpError(400, 'invalid', 'Original bout not found in this event.');
    const freed = new Set([old.fighter_a_id, old.fighter_b_id]);
    if (freed.has(a.fighter_id)) a = { ...a, active_bout_in_event: false };
    if (freed.has(b.fighter_id)) b = { ...b, active_bout_in_event: false };
  }

  const evaluation = evaluatePair(a, b, pool.event, pool.rules, pool.weight_classes);
  const { data: bout, error: e2 } = await db.rpc('svc_create_bout', {
    p_actor: uid,
    p: { ...p, weight_class_id: p.weight_class_id ?? evaluation.proposed_weight_class?.id ?? null, evaluation },
  });
  if (e2) throw e2;
  return json(req, { bout, evaluation });
});
