// Fighter portal: log in with fighter ID + date of birth, see own offers, accept/decline; Gmail config.
import { describe, expect, it } from 'vitest';
import { actAs, asOwner, attempt, createBout, createEvent, createFighter, createUser, tx, type Db } from './helpers';

async function setup(c: Db) {
  const admin = await createUser(c, { orgRole: 'org_admin' });
  const ev = await createEvent(c);
  const a = await createFighter(c, { eventId: ev.id });
  const b = await createFighter(c, { eventId: ev.id });
  await c.query(`update public.fighter_private set date_of_birth = '1987-03-10' where fighter_id = $1`, [a.id]);
  const bout = await createBout(c, ev.id, a.id, b.id);
  await actAs(c, admin);
  await c.query('select public.issue_offers($1)', [bout.id]);
  await actAs(c, 'anon');
  return { a, b, bout };
}
const login = async (c: Db, code: string, pw: string) => (await c.query('select public.public_fighter_login($1, $2) as r', [code, pw])).rows[0].r;
const portal = async (c: Db, s: string | null) => (await c.query('select public.public_fighter_portal($1) as r', [s])).rows[0].r;

describe('fighter portal', () => {
  it('logs in with fighter ID + DDMMYYYY and shows only that fighter\'s offers, without private data', async () => {
    await tx(async (c) => {
      const { a } = await setup(c);
      expect(await login(c, a.fighter_code, '01011998')).toEqual({ ok: false, code: 'login_failed' });
      const ok = await login(c, a.fighter_code.toLowerCase(), '10-03-1987');
      expect(ok.ok).toBe(true);
      expect(ok.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const p = await portal(c, ok.session);
      expect(p.fighter.fighter_code).toBe(a.fighter_code);
      expect(p.offers).toHaveLength(1);
      expect(p.offers[0]).toMatchObject({ status: 'pending', can_respond: true, fighter: { fighter_code: a.fighter_code } });
      expect(p.registrations).toHaveLength(1);
      expect(JSON.stringify(p)).not.toMatch(/@|date_of_birth|legal_name|token/);
    });
  });

  it('accepts and declines only the logged-in fighter\'s own offers', async () => {
    await tx(async (c) => {
      const { a, b } = await setup(c);
      const s = (await login(c, a.fighter_code, '10031987')).session;
      const mine = (await portal(c, s)).offers[0].offer_id;
      await asOwner(c);
      const theirs = (await c.query('select id from public.bout_offers where fighter_id = $1', [b.id])).rows[0].id;
      await actAs(c, 'anon');
      expect((await c.query(`select public.public_fighter_respond($1, $2, 'accept') as r`, [s, theirs])).rows[0].r).toEqual({ ok: false, code: 'not_found' });
      const r = (await c.query(`select public.public_fighter_respond($1, $2, 'accept') as r`, [s, mine])).rows[0].r;
      expect(r).toMatchObject({ ok: true, response: 'accept', bout_status: 'accepted_one' });
      expect((await portal(c, s)).offers[0]).toMatchObject({ status: 'accepted', can_respond: false });
    });
  });

  it('rejects bad or expired sessions, logs out, and locks an ID after 10 wrong passwords', async () => {
    await tx(async (c) => {
      const { a } = await setup(c);
      expect(await portal(c, 'x'.repeat(43))).toEqual({ ok: false, code: 'session_expired' });
      expect(await portal(c, null)).toEqual({ ok: false, code: 'session_expired' });
      const s = (await login(c, a.fighter_code, '10031987')).session;
      await c.query('select public.public_fighter_logout($1)', [s]);
      expect((await portal(c, s)).code).toBe('session_expired');
      const s2 = (await login(c, a.fighter_code, '10031987')).session;
      await asOwner(c);
      await c.query(`update public.fighter_sessions set expires_at = now() - interval '1 minute'`);
      await actAs(c, 'anon');
      expect((await portal(c, s2)).code).toBe('session_expired');
      for (let i = 0; i < 10; i++) expect((await login(c, a.fighter_code, `0101${1990 + i}`)).code).toBe('login_failed');
      expect(await login(c, a.fighter_code, '10031987')).toEqual({ ok: false, code: 'login_locked' });
    });
  });

  it('sessions and the email config are unreachable from the API', async () => {
    await tx(async (c) => {
      for (const who of ['anon', await createUser(c, { orgRole: 'org_admin' })] as const) {
        await actAs(c, who);
        expect(await attempt(c, 'select * from public.fighter_sessions')).toBeTruthy();
        expect(await attempt(c, 'select public.svc_email_config()')).toBeTruthy();
        await asOwner(c);
      }
      await actAs(c, 'service_role');
      const cfg = (await c.query('select public.svc_email_config() as r')).rows[0].r;
      expect(cfg.dispatch_secret).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
