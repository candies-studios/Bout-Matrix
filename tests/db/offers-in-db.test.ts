// Offers issued and answered entirely in the database (no Edge Functions): admin gets the links,
// fighters accept/decline as anonymous visitors, the admin confirms.
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actAs, asOwner, attempt, createBout, createEvent, createFighter, createUser, grantEvent, tx } from './helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function setup(c: Parameters<Parameters<typeof tx>[0]>[0]) {
  const admin = await createUser(c, { orgRole: 'org_admin' });
  const ev = await createEvent(c);
  const a = await createFighter(c, { eventId: ev.id, weightG: 70000 });
  const b = await createFighter(c, { eventId: ev.id, weightG: 70500 });
  const bout = await createBout(c, ev.id, a.id, b.id);
  return { admin, ev, a, b, bout };
}

type Issued = { status: string; offer_version: number; links: { offer_id: string; corner: string; token: string; fighter_code: string }[] };

describe('offers in the database', () => {
  it('admin issues offers and gets one working personal link per fighter; only the hash is stored', async () => {
    await tx(async (c) => {
      const { admin, a, bout } = await setup(c);
      await actAs(c, admin);
      const r = (await c.query('select public.issue_offers($1) as r', [bout.id])).rows[0].r as Issued;
      expect(r.status).toBe('offer_sent');
      expect(r.links).toHaveLength(2);
      expect(r.links.map((l) => l.corner).sort()).toEqual(['A', 'B']);
      expect(r.links.find((l) => l.corner === 'A')!.fighter_code).toBe(a.fighter_code);
      for (const l of r.links) expect(l.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      await asOwner(c);
      const offers = (await c.query('select id, token_hash, token_nonce from public.bout_offers where bout_id = $1', [bout.id])).rows;
      expect(offers).toHaveLength(2);
      for (const l of r.links) {
        const o = offers.find((x) => x.id === l.offer_id)!;
        expect(o.token_hash).toBe(sha(l.token));
        // Same format as the Edge Function tokens: base64url(HMAC-SHA256(secret, "id:nonce")).
        const secret = (await c.query(`select value from private.app_secrets where name = 'offer_token_secret'`)).rows[0].value;
        expect(createHmac('sha256', secret).update(`${o.id}:${o.token_nonce}`).digest('base64url')).toBe(l.token);
      }
      // The queued offer emails will get the same link from the database.
      const mat = (await c.query('select public.svc_offer_token_material($1) as m', [r.links[0].offer_id])).rows[0].m;
      expect(mat.token).toBe(r.links[0].token);

      // Copy link later returns the same token.
      await actAs(c, admin);
      const again = (await c.query('select public.get_offer_link($1) as r', [r.links[0].offer_id])).rows[0].r;
      expect(again.token).toBe(r.links[0].token);
    });
  });

  it('full flow without Edge Functions: view → accept × 2 → admin confirms', async () => {
    await tx(async (c) => {
      const { admin, bout } = await setup(c);
      await actAs(c, admin);
      const { links } = (await c.query('select public.issue_offers($1, 48) as r', [bout.id])).rows[0].r as Issued;

      await actAs(c, 'anon');
      const view = (await c.query('select public.public_get_offer($1) as r', [links[0].token])).rows[0].r;
      expect(view.ok).toBe(true);
      expect(view.can_respond).toBe(true);
      expect(JSON.stringify(view)).not.toMatch(/@|legal_name|date_of_birth/);

      const r1 = (await c.query(`select public.public_respond_offer($1, 'accept') as r`, [links[0].token])).rows[0].r;
      expect(r1).toMatchObject({ ok: true, response: 'accept', bout_status: 'accepted_one' });
      const replay = (await c.query(`select public.public_respond_offer($1, 'decline') as r`, [links[0].token])).rows[0].r;
      expect(replay).toMatchObject({ ok: false, code: 'already_responded' });
      const r2 = (await c.query(`select public.public_respond_offer($1, 'accept') as r`, [links[1].token])).rows[0].r;
      expect(r2.bout_status).toBe('accepted_both');

      await actAs(c, admin);
      await c.query(`select public.transition_bout($1, 'confirmed', null, (select updated_at from public.bouts where id = $1))`, [bout.id]);
      await asOwner(c);
      expect((await c.query('select status from public.bouts where id = $1', [bout.id])).rows[0].status).toBe('confirmed');
    });
  });

  it('a decline records the reason and withdraws the other offer', async () => {
    await tx(async (c) => {
      const { admin, bout } = await setup(c);
      await actAs(c, admin);
      const { links } = (await c.query('select public.issue_offers($1) as r', [bout.id])).rows[0].r as Issued;
      await actAs(c, 'anon');
      const r = (await c.query(`select public.public_respond_offer($1, 'decline', '  Injured  ') as r`, [links[1].token])).rows[0].r;
      expect(r.bout_status).toBe('declined');
      const other = (await c.query('select public.public_get_offer($1) as r', [links[0].token])).rows[0].r;
      expect(other.can_respond).toBe(false);
      await asOwner(c);
      expect((await c.query('select decline_reason from public.bout_responses where bout_id = $1', [bout.id])).rows[0].decline_reason).toBe('Injured');
    });
  });

  it('rejects bad tokens, bad answers and users without access', async () => {
    await tx(async (c) => {
      const { ev, bout } = await setup(c);
      await actAs(c, 'anon');
      expect((await c.query(`select public.public_get_offer('nope') as r`)).rows[0].r).toMatchObject({ ok: false, code: 'not_found' });
      expect((await c.query(`select public.public_get_offer($1) as r`, ['A'.repeat(43)])).rows[0].r).toMatchObject({ ok: false, code: 'not_found' });
      expect(await attempt(c, 'select public.issue_offers($1)', [bout.id])).toBeTruthy(); // anon cannot issue

      await asOwner(c);
      const stranger = await createUser(c);
      const matchmaker = await createUser(c, { orgRole: 'staff' });
      await grantEvent(c, ev.id, matchmaker.uid, 'matchmaker');
      await actAs(c, stranger);
      expect((await attempt(c, 'select public.issue_offers($1)', [bout.id]))?.message).toMatch(/not found/i);
      await actAs(c, matchmaker);
      const { links } = (await c.query('select public.issue_offers($1) as r', [bout.id])).rows[0].r as Issued;
      await actAs(c, 'anon');
      expect((await c.query(`select public.public_respond_offer($1, 'maybe') as r`, [links[0].token])).rows[0].r).toMatchObject({ ok: false, code: 'invalid' });
      await actAs(c, stranger);
      expect((await attempt(c, 'select public.get_offer_link($1)', [links[0].offer_id]))?.message).toMatch(/not found/i);
    });
  });

  it('API roles cannot read the token secret or call the internal helpers', async () => {
    await tx(async (c) => {
      const user = await createUser(c, { orgRole: 'org_admin' });
      for (const who of ['anon', user] as const) {
        await actAs(c, who);
        expect(await attempt(c, 'select value from private.app_secrets')).toBeTruthy();
        expect(await attempt(c, `select private.offer_token(gen_random_uuid(), 'x')`)).toBeTruthy();
        expect(await attempt(c, `select public.svc_issue_offers_auto(gen_random_uuid(), gen_random_uuid(), 1)`)).toBeTruthy();
      }
    });
  });

  it('rate limits answers per IP when the IP is known', async () => {
    await tx(async (c) => {
      await actAs(c, 'anon');
      await c.query(`select set_config('request.headers', '{"x-forwarded-for":"203.0.113.9, 10.0.0.1"}', true)`);
      const codes: string[] = [];
      for (let i = 0; i < 22; i++) codes.push((await c.query(`select public.public_respond_offer('bad', 'accept') as r`)).rows[0].r.code);
      expect(codes.slice(0, 20).every((x) => x === 'not_found')).toBe(true);
      expect(codes.slice(20)).toEqual(['rate_limited', 'rate_limited']);
    });
  });
});

describe('placeholder emails', () => {
  it('queues nothing for fighters whose address ends in .invalid', async () => {
    await tx(async (c) => {
      const { admin, bout } = await setup(c);
      await asOwner(c);
      await c.query(`update public.fighter_private set email = 'rs8-row9@no-email.invalid'
                      where fighter_id = (select fighter_a_id from public.bouts where id = $1)`, [bout.id]);
      await actAs(c, admin);
      await c.query('select public.issue_offers($1)', [bout.id]);
      await asOwner(c);
      const { rows } = await c.query(`select to_email from public.email_logs where template = 'bout_offer' and entity_id in
                                      (select id from public.bout_offers where bout_id = $1)`, [bout.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].to_email).not.toMatch(/\.invalid$/);
    });
  });
});
