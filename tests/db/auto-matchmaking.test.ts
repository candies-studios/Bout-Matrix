import { afterAll, describe, expect, it } from 'vitest';
import { actAs, asOwner, attempt, createEvent, createFighter, createUser, grantEvent, pool, tx, type Db } from './helpers';

afterAll(() => pool.end());

async function setup(c: Db) {
  const ev = await createEvent(c, `auto-${Math.random().toString(36).slice(2, 8)}`, { status: 'matchmaking' });
  const admin = await createUser(c, { orgRole: 'org_admin' });
  const mk = async (name: string, kg: number) => {
    const f = await createFighter(c, { eventId: ev.id, name, weightG: kg * 1000 });
    await c.query(`update public.event_registrations set clearance_status = 'cleared' where fighter_id = $1`, [f.id]);
    await c.query(`insert into public.fighter_records (fighter_id, kind, wins, losses) values ($1, 'self_reported', 3, 1)`, [f.id]);
    return f;
  };
  const a = await mk('Alpha', 70);
  const b = await mk('Bravo', 70.5);
  const far = await mk('Heavy', 95);
  return { ev, admin, a, b, far };
}

async function suggestions(c: Db, who: { uid: string }, eventId: string) {
  await actAs(c, who);
  const { rows } = await c.query('select public.get_match_suggestions($1) as r', [eventId]);
  await asOwner(c);
  return rows[0].r as { stats: Record<string, number>; suggestions: { id: string; fighter_a: { fight_name: string }; fighter_b: { fight_name: string }; classification: string }[] };
}

describe('automatic matchmaking', () => {
  it('computes suggestions on first view, without any button or Edge Function', async () => {
    await tx(async (c) => {
      const { ev, admin } = await setup(c);
      const r = await suggestions(c, admin, ev.id);
      expect(r.stats).toMatchObject({ registrants: 3, approved: 3, ready: 3 });
      expect(r.suggestions).toHaveLength(1); // Alpha vs Bravo; Heavy is too far away
      const names = [r.suggestions[0].fighter_a.fight_name, r.suggestions[0].fighter_b.fight_name].sort();
      expect(names).toEqual(['Alpha', 'Bravo']);
    });
  });

  it('refreshes automatically when a registration changes (e.g. a new approval or weight update)', async () => {
    await tx(async (c) => {
      const { ev, admin, far } = await setup(c);
      expect((await suggestions(c, admin, ev.id)).suggestions).toHaveLength(1);
      // Heavy cuts to 70.8 kg → now matches both others.
      await actAs(c, admin);
      await c.query(`update public.event_registrations set declared_weight_g = 70800, weight_recorded_at = now() where fighter_id = $1`, [far.id]);
      await asOwner(c);
      expect((await c.query('select suggestions_stale from public.events where id = $1', [ev.id])).rows[0].suggestions_stale).toBe(true);
      expect((await suggestions(c, admin, ev.id)).suggestions).toHaveLength(3);
      // A newly submitted (not yet approved) registrant is not suggested until approved.
      const late = await createFighter(c, { name: 'Late', weightG: 70200 });
      await c.query(
        `insert into public.event_registrations (event_id, fighter_id, status, submitted_via, declared_weight_g, weight_recorded_at, weight_unit_entered, division, competition_level, clearance_status)
         values ($1, $2, 'submitted', 'self', 70200, now(), 'kg', 'men', 'amateur', 'cleared')`,
        [ev.id, late.id],
      );
      await c.query(`insert into public.fighter_records (fighter_id, kind, wins, losses) values ($1, 'self_reported', 3, 1)`, [late.id]);
      let r = await suggestions(c, admin, ev.id);
      expect(r.suggestions).toHaveLength(3);
      expect(r.stats.awaiting_review).toBe(1);
      await actAs(c, admin);
      const reg = await c.query('select id from public.event_registrations where fighter_id = $1', [late.id]);
      await c.query(`select public.review_registration($1, 'approved')`, [reg.rows[0].id]);
      await asOwner(c);
      r = await suggestions(c, admin, ev.id);
      expect(r.suggestions).toHaveLength(6);
    });
  });

  it('dismissed pairs stay dismissed; booked fighters drop out of suggestions', async () => {
    await tx(async (c) => {
      const { ev, admin, a, b } = await setup(c);
      const s = (await suggestions(c, admin, ev.id)).suggestions[0];
      await actAs(c, admin);
      await c.query('select public.dismiss_suggestion($1)', [s.id]);
      await c.query(`update public.event_registrations set availability_notes = 'touch' where fighter_id = $1`, [a.id]); // forces refresh
      await asOwner(c);
      expect((await suggestions(c, admin, ev.id)).suggestions).toHaveLength(0);
      void b;
    });
  });

  it('create_bout re-evaluates on the server and ignores any evaluation sent by the browser', async () => {
    await tx(async (c) => {
      const { ev, admin, a, far } = await setup(c);
      await actAs(c, admin);
      // Alpha vs Heavy is ineligible (25 kg apart); a forged "strong" evaluation must not help.
      const err = await attempt(c, 'select public.create_bout($1)', [
        JSON.stringify({ event_id: ev.id, fighter_a_id: a.id, fighter_b_id: far.id, evaluation: { classification: 'strong_candidate' } }),
      ]);
      expect(err?.message).toMatch(/Record a reason/);
      const s = (await suggestions(c, admin, ev.id)).suggestions[0];
      await actAs(c, admin);
      const { rows } = await c.query('select * from public.create_bout($1)', [
        JSON.stringify({ event_id: ev.id, fighter_a_id: (s as unknown as { fighter_a_id: string }).fighter_a_id, fighter_b_id: (s as unknown as { fighter_b_id: string }).fighter_b_id, suggestion_id: s.id }),
      ]);
      expect(rows[0].status).toBe('draft');
      expect(rows[0].evaluation.classification).toBe(s.classification);
      expect(rows[0].weight_class_id).not.toBeNull(); // proposed class filled in automatically
      await asOwner(c);
      expect((await suggestions(c, admin, ev.id)).suggestions).toHaveLength(0); // both now booked
    });
  });

  it('is restricted to staff of the event', async () => {
    await tx(async (c) => {
      const { ev } = await setup(c);
      const stranger = await createUser(c, { orgRole: 'staff' });
      const mm = await createUser(c, { orgRole: 'staff' });
      await grantEvent(c, ev.id, mm.uid, 'matchmaker');
      await actAs(c, stranger);
      expect((await attempt(c, 'select public.get_match_suggestions($1)', [ev.id]))?.message).toMatch(/not found/);
      await actAs(c, 'anon');
      expect((await attempt(c, 'select public.get_match_suggestions($1)', [ev.id]))?.message).toMatch(/permission denied/);
      await asOwner(c);
      expect((await suggestions(c, mm, ev.id)).suggestions).toHaveLength(1);
    });
  });

  it('the scheduled job refreshes stale events', async () => {
    await tx(async (c) => {
      const { ev } = await setup(c);
      await actAs(c, 'service_role');
      const n = (await c.query('select public.svc_refresh_stale_suggestions() as n')).rows[0].n;
      await asOwner(c);
      expect(n).toBeGreaterThanOrEqual(1);
      const r = await c.query(`select count(*)::int as n from public.matchmaking_suggestions where event_id = $1 and status = 'open'`, [ev.id]);
      expect(r.rows[0].n).toBe(1);
    });
  });
});
