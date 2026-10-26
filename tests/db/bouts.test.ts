import { afterAll, describe, expect, it } from 'vitest';
import { BOUT_STATUSES, BOUT_TRANSITIONS } from '../../supabase/functions/_shared/domain/boutStatus';
import {
  acceptBoth, actAs, asOwner, attempt, createBout, createEvent, createFighter, createUser, grantEvent, pool, tx,
} from './helpers';

afterAll(() => pool.end());

describe('bout state machine', () => {
  it('database transitions match the shared TypeScript definition exactly', async () => {
    await tx(async (c) => {
      const { rows } = await c.query('select from_status, to_status from public.bout_status_transitions');
      const db = new Set(rows.map((r) => `${r.from_status}>${r.to_status}`));
      const ts = new Set(BOUT_STATUSES.flatMap((f) => BOUT_TRANSITIONS[f].map((t) => `${f}>${t}`)));
      expect(db).toEqual(ts);
      const enumRows = await c.query(`select unnest(enum_range(null::public.bout_status))::text as s`);
      expect(enumRows.rows.map((r) => r.s)).toEqual([...BOUT_STATUSES]);
    });
  });

  it('rejects invalid transitions, even for the database owner', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createFighter(c, { eventId: ev.id });
      const bout = await createBout(c, ev.id, a.id, b.id);
      for (const to of ['confirmed', 'accepted_both', 'completed', 'declined']) {
        const err = await attempt(c, `update public.bouts set status = $2 where id = $1`, [bout.id, to]);
        expect(err?.message, to).toMatch(/invalid bout status transition/);
      }
    });
  });

  it('cannot be created outside draft or already published', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createFighter(c, { eventId: ev.id });
      const err = await attempt(
        c,
        `insert into public.bouts (org_id, event_id, fighter_a_id, fighter_b_id, status) select org_id, id, $2, $3, 'confirmed' from public.events where id = $1`,
        [ev.id, a.id, b.id],
      );
      expect(err?.message).toMatch(/draft/);
    });
  });

  it('confirmation requires both acceptances of the current offer version and an admin user', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const admin = await createUser(c, { orgRole: 'staff' });
      await grantEvent(c, ev.id, admin.uid, 'event_admin');
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createFighter(c, { eventId: ev.id });
      const bout = await createBout(c, ev.id, a.id, b.id);
      await acceptBoth(c, bout.id);

      // System actors (e.g. the offer workflow) can never confirm.
      await c.query(`select private.set_context(null, 'system', 'auto')`);
      expect((await attempt(c, `update public.bouts set status = 'confirmed' where id = $1`, [bout.id]))?.message).toMatch(
        /authenticated administrator/,
      );

      // Changing terms during review invalidates acceptances.
      await actAs(c, admin);
      await c.query(`select public.transition_bout($1, 'under_review', 'weight check')`, [bout.id]);
      await c.query(`update public.bouts set rounds = 5 where id = $1`, [bout.id]);
      const err = await attempt(c, `select public.transition_bout($1, 'confirmed', 'ok')`, [bout.id]);
      expect(err?.message).toMatch(/both fighters accept the current offer/);

      await asOwner(c);
      const { rows } = await c.query('select offer_version from public.bouts where id = $1', [bout.id]);
      expect(rows[0].offer_version).toBe(2);
    });
  });

  it('records status history with actor and reason, and requires reasons where mandated', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createFighter(c, { eventId: ev.id });
      const bout = await createBout(c, ev.id, a.id, b.id);
      await actAs(c, admin);
      expect((await attempt(c, `select public.transition_bout($1, 'cancelled', null)`, [bout.id]))?.message).toMatch(
        /reason is required/,
      );
      await c.query(`select public.transition_bout($1, 'cancelled', 'Venue fell through')`, [bout.id]);
      const { rows } = await c.query(
        `select from_status, to_status, actor_id, reason from public.bout_status_history where bout_id = $1 order by id`,
        [bout.id],
      );
      expect(rows.at(-1)).toEqual({ from_status: 'draft', to_status: 'cancelled', actor_id: admin.uid, reason: 'Venue fell through' });
      // History is append-only.
      await asOwner(c);
      expect((await attempt(c, `delete from public.bout_status_history where bout_id = $1`, [bout.id]))?.message).toMatch(
        /append-only/,
      );
    });
  });

  it('terms cannot change once offers are out', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createFighter(c, { eventId: ev.id });
      const bout = await createBout(c, ev.id, a.id, b.id);
      await acceptBoth(c, bout.id);
      const err = await attempt(c, `update public.bouts set contracted_weight_g = 71000 where id = $1`, [bout.id]);
      expect(err?.message).toMatch(/terms can only be changed/);
    });
  });

  it('optimistic concurrency rejects stale writes', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createBout(c, ev.id, a.id, (await createFighter(c, { eventId: ev.id })).id);
      await actAs(c, admin);
      const err = await attempt(c, `select public.transition_bout($1, 'cancelled', 'x', now() - interval '1 hour')`, [b.id]);
      expect(err?.message).toMatch(/modified by someone else/);
    });
  });
});

describe('conflicting bouts', () => {
  it('a fighter cannot hold two active bouts in the same event', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createFighter(c, { eventId: ev.id });
      const d = await createFighter(c, { eventId: ev.id });
      await createBout(c, ev.id, a.id, b.id);
      const err = await attempt(
        c,
        `insert into public.bouts (org_id, event_id, fighter_a_id, fighter_b_id) select org_id, id, $2, $3 from public.events where id = $1`,
        [ev.id, d.id, a.id],
      );
      expect(err?.message).toMatch(/already has an active bout/);
    });
  });

  it('a cancelled bout releases both fighters for a replacement, and the original history is kept', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createFighter(c, { eventId: ev.id });
      const d = await createFighter(c, { eventId: ev.id });
      const first = await createBout(c, ev.id, a.id, b.id);
      await actAs(c, admin);
      await c.query(`select public.transition_bout($1, 'cancelled', 'Fighter B withdrew')`, [first.id]);
      await asOwner(c);
      const second = await c.query(
        `insert into public.bouts (org_id, event_id, fighter_a_id, fighter_b_id, replaces_bout_id)
         select org_id, id, $2, $3, $4 from public.events where id = $1 returning id`,
        [ev.id, a.id, d.id, first.id],
      );
      expect(second.rowCount).toBe(1);
      const orig = await c.query('select status, cancel_reason from public.bouts where id = $1', [first.id]);
      expect(orig.rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'Fighter B withdrew' });
    });
  });

  it('the same fighter may fight in different events', async () => {
    await tx(async (c) => {
      const ev1 = await createEvent(c);
      const ev2 = await createEvent(c);
      const a = await createFighter(c, { eventId: ev1.id });
      await c.query(
        `insert into public.event_registrations (event_id, fighter_id, submitted_via, division, competition_level)
         values ($1, $2, 'self', 'men', 'amateur')`,
        [ev2.id, a.id],
      );
      await createBout(c, ev1.id, a.id, (await createFighter(c, { eventId: ev1.id })).id);
      await createBout(c, ev2.id, a.id, (await createFighter(c, { eventId: ev2.id })).id);
      const { rows } = await c.query('select count(*)::int as n from public.bout_participants where fighter_id = $1 and is_active', [a.id]);
      expect(rows[0].n).toBe(2);
    });
  });
});
