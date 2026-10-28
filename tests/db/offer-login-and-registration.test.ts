// Offer login (fighter ID + DOB as DDMMYYYY) and registration without Edge Functions.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actAs, asOwner, attempt, createBout, createEvent, createFighter, createUser, tx, type Db } from './helpers';

async function offerSetup(c: Db) {
  const admin = await createUser(c, { orgRole: 'org_admin' });
  const ev = await createEvent(c);
  const a = await createFighter(c, { eventId: ev.id });
  const b = await createFighter(c, { eventId: ev.id });
  await c.query(`update public.fighter_private set date_of_birth = '1987-03-10' where fighter_id = $1`, [a.id]);
  const bout = await createBout(c, ev.id, a.id, b.id);
  await actAs(c, admin);
  const { links } = (await c.query('select public.issue_offers($1) as r', [bout.id])).rows[0].r as { links: { corner: string; token: string; fighter_code: string }[] };
  await actAs(c, 'anon');
  return { a, b, linkA: links.find((l) => l.corner === 'A')!, linkB: links.find((l) => l.corner === 'B')! };
}
const view = async (c: Db, token: string, code: string | null, pw: string | null) =>
  (await c.query('select public.public_get_offer($1, $2, $3) as r', [token, code, pw])).rows[0].r;

describe('offer login', () => {
  it('shows nothing without logging in, and nothing for wrong credentials', async () => {
    await tx(async (c) => {
      const { linkA, linkB } = await offerSetup(c);
      const none = await view(c, linkA.token, null, null);
      expect(none).toEqual({ ok: false, code: 'login_required' });
      expect(await view(c, linkA.token, linkA.fighter_code, '01011998')).toEqual({ ok: false, code: 'login_failed' });   // wrong DOB
      expect(await view(c, linkA.token, linkB.fighter_code, '01011998')).toEqual({ ok: false, code: 'login_failed' });   // other fighter's ID + DOB
    });
  });

  it('opens with fighter ID + DOB as DDMMYYYY (case and separators forgiven) and lets the fighter answer', async () => {
    await tx(async (c) => {
      const { linkA } = await offerSetup(c);
      const ok = await view(c, linkA.token, linkA.fighter_code.toLowerCase(), '10/03/1987');
      expect(ok.ok).toBe(true);
      expect(ok.fighter.fighter_code).toBe(linkA.fighter_code);
      const blocked = (await c.query(`select public.public_respond_offer($1, 'accept', null, $2, '11031987') as r`, [linkA.token, linkA.fighter_code])).rows[0].r;
      expect(blocked).toEqual({ ok: false, code: 'login_failed' });
      const r = (await c.query(`select public.public_respond_offer($1, 'accept', null, $2, '10031987') as r`, [linkA.token, linkA.fighter_code])).rows[0].r;
      expect(r.ok).toBe(true);
    });
  });

  it('locks a link for an hour after 10 wrong passwords, even for the right one', async () => {
    await tx(async (c) => {
      const { linkA } = await offerSetup(c);
      for (let i = 0; i < 10; i++) expect((await view(c, linkA.token, linkA.fighter_code, `0101${1990 + i}`)).code).toBe('login_failed');
      expect(await view(c, linkA.token, linkA.fighter_code, '10031987')).toEqual({ ok: false, code: 'login_locked' });
    });
  });

  it('the opponent does not see the offer as opened until the fighter logs in', async () => {
    await tx(async (c) => {
      const { linkA } = await offerSetup(c);
      await view(c, linkA.token, null, null);
      await asOwner(c);
      const { rows } = await c.query(`select first_viewed_at from public.bout_offers o join public.fighters f on f.id = o.fighter_id where f.fighter_code = $1`, [linkA.fighter_code]);
      expect(rows[0].first_viewed_at).toBeNull();
    });
  });
});

describe('public fighter registration (no Edge Functions)', () => {
  const form = (slug: string, over: Record<string, unknown> = {}) => ({
    submission_key: randomUUID(), event_slug: slug, legal_name: 'Ravi Kumar', fight_name: 'Ravi Kumar', date_of_birth: '2001-05-04',
    email: 'Ravi.Kumar@Example.com', phone_country_code: '+91', phone: '9876543210', city: 'Pune', country: 'India',
    division: 'men', competition_level: 'amateur', wins: 1, losses: 0, draws: 0, no_contests: 0, weight_value: 70.2, weight_unit: 'kg',
    gym_name: 'Ravi Gym', is_available: true, consent_data: true, consent_rules: true, documents: [], website: '', ...over,
  });

  it('an anonymous visitor registers and gets their fighter ID back', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c, undefined, { status: 'registration_open', is_public: true });
      await actAs(c, 'anon');
      const r = (await c.query('select public.public_register_fighter($1) as r', [JSON.stringify(form(ev.slug))])).rows[0].r;
      expect(r.status).toBe('created');
      expect(r.fighter_code).toMatch(/-F-\d{4}$/);
      await asOwner(c);
      const reg = (await c.query(`select er.declared_weight_g, er.status, fp.email from public.event_registrations er
                                   join public.fighter_private fp on fp.fighter_id = er.fighter_id where er.event_id = $1`, [ev.id])).rows[0];
      expect(reg).toMatchObject({ declared_weight_g: 70200, status: 'submitted', email: 'ravi.kumar@example.com' });
    });
  });

  it('rejects missing consent, the honeypot, bad weights, unknown upload paths and closed events', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c, undefined, { status: 'registration_open', is_public: true });
      const closed = await createEvent(c, undefined, { status: 'registration_closed', is_public: true });
      await actAs(c, 'anon');
      const run = (p: object) => attempt(c, 'select public.public_register_fighter($1)', [JSON.stringify(p)]);
      expect((await run(form(ev.slug, { consent_rules: false })))?.message).toMatch(/agree/);
      expect(await run(form(ev.slug, { website: 'http://spam' }))).toBeTruthy();
      expect((await run(form(ev.slug, { weight_value: 400 })))?.message).toMatch(/Weight/);
      expect((await run(form(ev.slug, { photo_path: '../../etc/passwd' })))?.message).toMatch(/photo/);
      expect((await run(form(closed.slug)))?.message).toMatch(/closed/);
    });
  });

  it('a repeated submission (double click) returns the same fighter ID', async () => {
    await tx(async (c) => {
      const ev = await createEvent(c, undefined, { status: 'registration_open', is_public: true });
      await actAs(c, 'anon');
      const p = JSON.stringify(form(ev.slug));
      const a = (await c.query('select public.public_register_fighter($1) as r', [p])).rows[0].r;
      const b = (await c.query('select public.public_register_fighter($1) as r', [p])).rows[0].r;
      expect(b.fighter_code).toBe(a.fighter_code);
    });
  });
});
