import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ORG, actAs, asOwner, attempt, createEvent, createFighter, createUser, grantEvent, pool, tx } from './helpers';

afterAll(() => pool.end());

async function hint(c: Parameters<typeof attempt>[0], sql: string, params: unknown[]) {
  await c.query('savepoint h');
  try {
    await c.query(sql, params);
    await c.query('release savepoint h');
    return null;
  } catch (e) {
    await c.query('rollback to savepoint h');
    return (e as { hint?: string }).hint ?? (e as Error).message;
  }
}

describe('staff management', () => {
  it('only org admins can grant staff roles and event assignments', async () => {
    await tx(async (c) => {
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const staff = await createUser(c, { orgRole: 'staff' });
      const ev = await createEvent(c);
      const newUser = randomUUID();
      await c.query(`insert into auth.users (id, email) values ($1, 'new.staff@example.com')`, [newUser]);
      await actAs(c, 'service_role');
      expect(await hint(c, `select public.svc_grant_staff($1, $2, $3, 'new.staff@example.com', 'New', 'staff', $4, 'matchmaker')`, [staff.uid, ORG, newUser, ev.id])).toBe('forbidden');
      await c.query(`select public.svc_grant_staff($1, $2, $3, 'new.staff@example.com', 'New', 'staff', $4, 'matchmaker')`, [admin.uid, ORG, newUser, ev.id]);
      await asOwner(c);
      const r = await c.query(`select ea.role from public.event_admins ea where ea.user_id = $1`, [newUser]);
      expect(r.rows[0].role).toBe('matchmaker');
      // Event staff cannot assign others to events.
      await actAs(c, staff);
      expect((await attempt(c, `insert into public.event_admins (event_id, user_id, role, granted_by) values ($1, $2, 'event_admin', $2)`, [ev.id, staff.uid]))?.message).toMatch(/row-level security/);
    });
  });

  it('coach accounts can only be linked to verified coaches by org admins', async () => {
    await tx(async (c) => {
      const admin = await createUser(c, { orgRole: 'org_admin' });
      const { rows } = await c.query(`insert into public.coaches (org_id, full_name, email) values ($1, 'Pending Coach', 'pc@example.com') returning id`, [ORG]);
      const u = randomUUID();
      await c.query(`insert into auth.users (id, email) values ($1, 'pc@example.com')`, [u]);
      await actAs(c, 'service_role');
      expect(await hint(c, 'select public.svc_link_coach_user($1, $2, $3)', [admin.uid, rows[0].id, u])).toBe('invalid');
      await asOwner(c);
      await actAs(c, admin);
      await c.query(`select public.verify_coach($1, 'verified', 'Checked federation card')`, [rows[0].id]);
      await actAs(c, 'service_role');
      await c.query('select public.svc_link_coach_user($1, $2, $3)', [admin.uid, rows[0].id, u]);
      await asOwner(c);
      const roles = await c.query(`select role from public.user_roles where user_id = $1`, [u]);
      expect(roles.rows.map((x) => x.role)).toEqual(['coach']);
      const mail = await c.query(`select count(*)::int as n from public.email_logs where template = 'coach_verified' and to_email = 'pc@example.com'`);
      expect(mail.rows[0].n).toBe(1);
    });
  });
});

describe('notifications', () => {
  it('event announcements respect opt-outs; transactional emails ignore them', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c, `ann-${randomUUID().slice(0, 6)}`, { status: 'registration_open' });
      const admin = await createUser(c, { orgRole: 'org_admin' });
      await createFighter(c, { eventId: ev.id, email: 'in@example.com' });
      await createFighter(c, { eventId: ev.id, email: 'out@example.com' });
      await c.query(`insert into public.notification_preferences (org_id, email, category, enabled) values ($1, 'out@example.com', 'event_announcements', false)`, [ORG]);
      await actAs(c, admin);
      const n = (await c.query(`select public.announce_event($1, 'Weigh-ins at 9am') as n`, [ev.id])).rows[0].n;
      expect(n).toBe(1);
      await asOwner(c);
      const rows = await c.query(`select to_email from public.email_logs where template = 'event_announcement' and event_id = $1`, [ev.id]);
      expect(rows.rows.map((r) => r.to_email)).toEqual(['in@example.com']);
    });
  });

  it('matchmakers cannot send event announcements', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c);
      const mm = await createUser(c, { orgRole: 'staff' });
      await grantEvent(c, ev.id, mm.uid, 'matchmaker');
      await actAs(c, mm);
      expect((await attempt(c, `select public.announce_event($1, 'hello there')`, [ev.id]))?.message).toMatch(/not found/);
    });
  });
});

describe('registration window', () => {
  it('rejects registrations before the window opens or after it closes', async () => {
    await tx(async (c) => {
      await createEvent(c, 'not-yet', { status: 'registration_open', registration_opens_at: new Date(Date.now() + 86400e3).toISOString() });
      await actAs(c, 'service_role');
      const p = { submission_key: randomUUID(), event_slug: 'not-yet', legal_name: 'Some One', fight_name: 'Some One', date_of_birth: '1999-01-01', email: 'so@example.com', division: 'men', competition_level: 'amateur' };
      expect(await hint(c, 'select public.svc_register_fighter($1)', [JSON.stringify(p)])).toBe('registration_closed');
      const anon = await c.query(`select registration_open from public.public_registration_event('not-yet')`);
      expect(anon.rows[0].registration_open).toBe(false);
    });
  });
});
