// Handpicked main card (set_main_card) and the bout export.
import { describe, expect, it } from 'vitest';
import { acceptBoth, actAs, asOwner, attempt, createBout, createEvent, createFighter, createUser, grantEvent, tx, type Db } from './helpers';

async function confirmedBouts(c: Db, n: number) {
  const admin = await createUser(c, { orgRole: 'org_admin' });
  const ev = await createEvent(c);
  const bouts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = await createFighter(c, { eventId: ev.id, name: `Red ${i}` });
    const b = await createFighter(c, { eventId: ev.id, name: `Blue ${i}` });
    const bout = await createBout(c, ev.id, a.id, b.id);
    await acceptBoth(c, bout.id);
    await actAs(c, admin);
    await c.query(`select public.transition_bout($1, 'confirmed', null, (select updated_at from public.bouts where id = $1))`, [bout.id]);
    await asOwner(c);
    if (i === 3) await c.query(`update public.bouts set card_segment = 'early_prelims' where id = $1`, [bout.id]);
    bouts.push(bout.id);
  }
  return { admin, ev, bouts };
}
const card = async (c: Db, ev: string) =>
  (await c.query(`select id, card_order, card_segment from public.bouts where event_id = $1 order by card_order`, [ev])).rows as { id: string; card_order: number; card_segment: string }[];

describe('handpicked main card', () => {
  it('puts the chosen bouts on the main card in the chosen order and everything else on the prelims', async () => {
    await tx(async (c) => {
      const { admin, ev, bouts } = await confirmedBouts(c, 5);
      await actAs(c, admin);
      const r = (await c.query('select public.set_main_card($1, $2) as r', [ev.id, [bouts[4], bouts[1]]])).rows[0].r;
      expect(r).toEqual({ main_card: 2, total: 5 });
      await asOwner(c);
      const rows = await card(c, ev.id);
      expect(rows.slice(0, 2)).toEqual([
        { id: bouts[4], card_order: 1, card_segment: 'main_card' },
        { id: bouts[1], card_order: 2, card_segment: 'main_card' },
      ]);
      expect(rows.slice(2).map((x) => x.card_segment)).toEqual(['prelims', 'prelims', 'early_prelims']);
      expect(rows.map((x) => x.card_order)).toEqual([1, 2, 3, 4, 5]);

      // Changing the pick moves the old main-card bout down to the prelims.
      await actAs(c, admin);
      await c.query('select public.set_main_card($1, $2)', [ev.id, [bouts[0]]]);
      await asOwner(c);
      const again = await card(c, ev.id);
      expect(again[0]).toMatchObject({ id: bouts[0], card_segment: 'main_card' });
      expect(again.filter((x) => x.card_segment === 'main_card')).toHaveLength(1);
    });
  });

  it("rejects other events' bouts, unconfirmed bouts, duplicates and non-admins", async () => {
    await tx(async (c) => {
      const { admin, ev, bouts } = await confirmedBouts(c, 2);
      const other = await confirmedBouts(c, 1);
      const a = await createFighter(c, { eventId: ev.id });
      const b = await createFighter(c, { eventId: ev.id });
      const draft = await createBout(c, ev.id, a.id, b.id);
      const mm = await createUser(c, { orgRole: 'staff' });
      await grantEvent(c, ev.id, mm.uid, 'matchmaker');
      await actAs(c, admin);
      expect((await attempt(c, 'select public.set_main_card($1, $2)', [ev.id, [other.bouts[0]]]))?.message).toMatch(/Only confirmed bouts/);
      expect((await attempt(c, 'select public.set_main_card($1, $2)', [ev.id, [draft.id]]))?.message).toMatch(/Only confirmed bouts/);
      expect((await attempt(c, 'select public.set_main_card($1, $2)', [ev.id, [bouts[0], bouts[0]]]))?.message).toMatch(/only appear once/);
      await actAs(c, mm);
      expect((await attempt(c, 'select public.set_main_card($1, $2)', [ev.id, [bouts[0]]]))?.message).toMatch(/not found/);
    });
  });
});

describe('bout export', () => {
  it('returns one row per bout with both corners, main card first; admins only', async () => {
    await tx(async (c) => {
      const { admin, ev, bouts } = await confirmedBouts(c, 3);
      await actAs(c, admin);
      await c.query('select public.set_main_card($1, $2)', [ev.id, [bouts[2]]]);
      const rows = (await c.query('select public.export_event_bouts($1) as r', [ev.id])).rows[0].r;
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ card_segment: 'main_card', card_order: 1, red: { name: 'Red 2' }, blue: { name: 'Blue 2' } });
      expect(rows[0].red).toMatchObject({ age: expect.any(Number), weight_g: 70000, legal_name: 'Legal Name' });
      expect(rows[0].red.fighter_code).toMatch(/-F-\d{4}$/);
      await asOwner(c);
      const anon = await createUser(c, { orgRole: 'staff' });
      await actAs(c, anon);
      expect((await attempt(c, 'select public.export_event_bouts($1)', [ev.id]))?.message).toMatch(/not found/);
    });
  });
});
