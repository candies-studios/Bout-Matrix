import { afterAll, describe, expect, it } from 'vitest';
import {
  DEMO_EVENT, ORG, acceptBoth, actAs, asOwner, attempt, createBout, createEvent, createFighter, createUser,
  grantEvent, pool, tx,
} from './helpers';

afterAll(() => pool.end());

describe('anonymous (public) access', () => {
  it('has no privileges on any table in the public schema', async () => {
    await tx(async (c) => {
      const { rows } = await c.query(`select tablename from pg_tables where schemaname = 'public'`);
      expect(rows.length).toBeGreaterThan(25);
      await actAs(c, 'anon');
      for (const { tablename } of rows) {
        const err = await attempt(c, `select 1 from public.${tablename} limit 1`);
        expect(err?.message, tablename).toMatch(/permission denied/);
      }
    });
  });

  it('cannot call privileged RPCs or private helpers', async () => {
    await tx(async (c) => {
      await actAs(c, 'anon');
      for (const sql of [
        `select public.transition_bout(gen_random_uuid(), 'confirmed', 'x')`,
        `select public.review_registration(gen_random_uuid(), 'approved')`,
        `select private.next_code('${ORG}', 'fighter')`,
        `select private.enqueue_email('${ORG}', null, 'x_y', 'a@b.co', null, '{}', 'abcdefghij', null, null)`,
      ]) {
        expect((await attempt(c, sql))?.message, sql).toMatch(/permission denied/);
      }
    });
  });

  it('every SECURITY DEFINER function pins search_path', async () => {
    await tx(async (c) => {
      const { rows } = await c.query(`
        select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') and p.prosecdef
           and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) s where s like 'search_path=%')`);
      expect(rows).toEqual([]);
    });
  });

  it('every public table has RLS enabled', async () => {
    await tx(async (c) => {
      const { rows } = await c.query(`
        select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
      expect(rows).toEqual([]);
    });
  });
});

describe('public fight card', () => {
  it('shows nothing until the event is public, the card is published and the bout is confirmed+published', async () => {
    await tx(async (c) => {
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const ev = await createEvent(c, 'card-test', { status: 'published' });
      const a = await createFighter(c, { eventId: ev.id, name: 'Alpha Test' });
      const b = await createFighter(c, { eventId: ev.id, name: 'Bravo Test' });
      const bout = await createBout(c, ev.id, a.id, b.id);

      const card = async () => {
        await actAs(c, 'anon');
        const r = await c.query(`select * from public.public_get_fight_card('card-test')`);
        await asOwner(c);
        return r.rows;
      };
      expect(await card()).toHaveLength(0);

      await acceptBoth(c, bout.id);
      await actAs(c, admin);
      await c.query(`select public.transition_bout($1, 'confirmed', 'ok')`, [bout.id]);
      await c.query(`select public.set_bout_published($1, true)`, [bout.id]);
      await asOwner(c);
      expect(await card()).toHaveLength(0); // event not public, card not published

      await c.query(`update public.events set is_public = true where id = $1`, [ev.id]);
      expect(await card()).toHaveLength(0); // card still unpublished
      await actAs(c, admin);
      await c.query(`select public.set_fight_card_published($1, true)`, [ev.id]);
      await asOwner(c);

      const rows = await card();
      expect(rows).toHaveLength(1);
      const json = JSON.stringify(rows[0]);
      expect(rows[0].fighter_a.fight_name).toBe('Alpha Test');
      // No private data, notes, tokens or internal IDs leak.
      for (const forbidden of ['Legal Name', '@fighter.example.com', '1998-01-01', a.id, b.id, bout.id, 'token']) {
        expect(json).not.toContain(forbidden);
      }

      // Moving the bout back under review unpublishes it automatically.
      await actAs(c, admin);
      await c.query(`select public.transition_bout($1, 'under_review', 'opponent injured')`, [bout.id]);
      await asOwner(c);
      expect(await card()).toHaveLength(0);
    });
  });

  it('hides draft events entirely', async () => {
    await tx(async (c) => {
      await createEvent(c, 'secret-draft', { is_public: true });
      await actAs(c, 'anon');
      const { rows } = await c.query(`select * from public.public_get_event('secret-draft')`);
      expect(rows).toHaveLength(0);
      const list = await c.query(`select slug from public.public_list_events()`);
      expect(list.rows.map((r) => r.slug)).not.toContain('secret-draft');
    });
  });

  it('shows "TBA" data as nulls rather than invented values', async () => {
    await tx(async (c) => {
      await actAs(c, 'anon');
      const { rows } = await c.query(`select starts_at, venue_name from public.public_get_event('demo-fight-night-1')`);
      expect(rows[0]).toEqual({ starts_at: null, venue_name: null });
    });
  });
});

describe('event separation', () => {
  it('event staff see only the events they are assigned to', async () => {
    await tx(async (c) => {
      const evA = await createEvent(c);
      const evB = await createEvent(c);
      await createFighter(c, { eventId: evA.id, name: 'Only In A' });
      await createFighter(c, { eventId: evB.id, name: 'Only In B' });
      const staff = await createUser(c, { orgRole: 'staff' });
      await grantEvent(c, evA.id, staff.uid, 'event_admin');

      await actAs(c, staff);
      const events = await c.query('select id from public.events');
      expect(events.rows.map((r) => r.id)).toEqual([evA.id]);
      const fighters = await c.query('select fight_name from public.fighters');
      expect(fighters.rows.map((r) => r.fight_name)).toEqual(['Only In A']);
      const regs = await c.query('select event_id from public.event_registrations');
      expect(new Set(regs.rows.map((r) => r.event_id))).toEqual(new Set([evA.id]));
      // Cannot edit the other event even by id.
      const upd = await c.query(`update public.events set name = 'hijack' where id = $1`, [evB.id]);
      expect(upd.rowCount).toBe(0);
    });
  });

  it('event assignment without an org staff role grants nothing', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const outsider = await createUser(c); // no org role
      await grantEvent(c, ev.id, outsider.uid, 'event_admin');
      await actAs(c, outsider);
      expect((await c.query('select id from public.events')).rowCount).toBe(0);
    });
  });

  it('matchmakers cannot confirm, cancel, publish or approve registrations', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createFighter(c, { eventId: ev.id });
      const bout = await createBout(c, ev.id, a.id, b.id);
      await acceptBoth(c, bout.id);
      const mm = await createUser(c, { orgRole: 'staff' });
      await grantEvent(c, ev.id, mm.uid, 'matchmaker');
      const { rows } = await c.query('select id from public.event_registrations where fighter_id = $1', [a.id]);

      await actAs(c, mm);
      expect((await attempt(c, `select public.transition_bout($1, 'confirmed', 'x')`, [bout.id]))?.message).toMatch(
        /only event administrators/,
      );
      expect((await attempt(c, `select public.transition_bout($1, 'cancelled', 'x')`, [bout.id]))?.message).toMatch(
        /only event administrators/,
      );
      expect((await attempt(c, `select public.set_bout_published($1, true)`, [bout.id]))?.message).toMatch(/not found/);
      expect(
        (await attempt(c, `select public.review_registration($1, 'rejected', 'x')`, [rows[0].id]))?.message,
      ).toMatch(/not found/);
      // But can put it under review.
      expect(await attempt(c, `select public.transition_bout($1, 'under_review', 'check weights')`, [bout.id])).toBeNull();
    });
  });

  it('org admins cannot grant super_admin and cannot see other organisations', async () => {
    await tx(async (c) => {
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const { rows } = await c.query(
        `insert into public.organizations (name, slug, fighter_id_prefix) values ('Other Org', 'other', 'OTH') returning id`,
      );
      const otherOrg = rows[0].id;
      await createFighter(c); // in ORG
      await actAs(c, admin);
      const err = await attempt(
        c,
        `insert into public.user_roles (user_id, org_id, role, granted_by) values ($1, $2, 'super_admin', $1)`,
        [admin.uid, ORG],
      );
      expect(err?.message).toMatch(/row-level security/);
      expect((await c.query('select id from public.organizations where id = $1', [otherOrg])).rowCount).toBe(0);
      const err2 = await attempt(
        c,
        `insert into public.user_roles (user_id, org_id, role, granted_by) values ($1, $2, 'org_admin', $1)`,
        [admin.uid, otherOrg],
      );
      expect(err2?.message).toMatch(/row-level security/);
    });
  });
});

describe('coach access', () => {
  it('a verified coach sees only fighters on their approved roster', async () => {
    await tx(async (c) => {
      const coachUser = await createUser(c, { orgRole: 'coach' });
      const { rows } = await c.query(
        `insert into public.coaches (org_id, user_id, full_name, email, verification_status)
         values ($1, $2, 'Coach Test', $3, 'verified') returning id`,
        [ORG, coachUser.uid, coachUser.email],
      );
      const mine = await createFighter(c, { eventId: DEMO_EVENT, name: 'My Fighter' });
      const pending = await createFighter(c, { eventId: DEMO_EVENT, name: 'Pending Link' });
      await c.query(`insert into public.coach_fighters (coach_id, fighter_id, status) values ($1, $2, 'approved'), ($1, $3, 'pending')`, [
        rows[0].id,
        mine.id,
        pending.id,
      ]);

      await actAs(c, coachUser);
      const visible = await c.query('select fight_name from public.fighters');
      expect(visible.rows.map((r) => r.fight_name)).toEqual(['My Fighter']);
      const priv = await c.query('select fighter_id from public.fighter_private');
      expect(priv.rows.map((r) => r.fighter_id)).toEqual([mine.id]);
      // Coaches cannot approve their own link requests.
      const upd = await c.query(`update public.coach_fighters set status = 'approved' where fighter_id = $1`, [pending.id]);
      expect(upd.rowCount).toBe(0);
      // Coaches cannot read bouts or other events' admin data.
      expect((await c.query('select id from public.events')).rowCount).toBe(0);
    });
  });

  it('an unverified coach sees nothing', async () => {
    await tx(async (c) => {
      const coachUser = await createUser(c, { orgRole: 'coach' });
      const { rows } = await c.query(
        `insert into public.coaches (org_id, user_id, full_name, email) values ($1, $2, 'Pending Coach', $3) returning id`,
        [ORG, coachUser.uid, coachUser.email],
      );
      const f = await createFighter(c);
      await c.query(`insert into public.coach_fighters (coach_id, fighter_id, status) values ($1, $2, 'approved')`, [rows[0].id, f.id]);
      await actAs(c, coachUser);
      expect((await c.query('select id from public.fighters')).rowCount).toBe(0);
    });
  });
});

describe('sensitive columns', () => {
  it('offer token hashes and nonces are not selectable by authenticated users', async () => {
    await tx(async (c) => {
      const admin = await createUser(c, { orgRole: 'org_admin' });
      await actAs(c, admin);
      expect((await attempt(c, 'select token_hash from public.bout_offers'))?.message).toMatch(/permission denied/);
      expect((await attempt(c, 'select token_nonce from public.bout_offers'))?.message).toMatch(/permission denied/);
      expect((await attempt(c, 'select ip_hash from public.bout_responses'))?.message).toMatch(/permission denied/);
      expect(await attempt(c, 'select id, status from public.bout_offers')).toBeNull();
    });
  });

  it('email payloads may not carry tokens or secrets', async () => {
    await tx(async (c) => {
      const err = await attempt(
        c,
        `insert into public.email_logs (org_id, template, to_email, payload, idempotency_key)
         values ($1, 'bout_offer', 'x@example.com', '{"token":"abc"}', 'test-key-1')`,
        [ORG],
      );
      expect(err?.message).toMatch(/check constraint/);
    });
  });
});
